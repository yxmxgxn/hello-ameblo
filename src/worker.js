/**
 * アメブロ検索 Worker (Static Assets 併用)
 *
 * 公開API
 *   GET /api/search?q=&m=&b=&g=&act=&d=&order=&cursor=  本文・タイトルの全文検索。前後数十字だけ返し、本文全体は返さない
 *   GET /api/members                      絞り込み用のメンバー一覧と収録状況
 *   GET /api/calendar?m=&b=&ym=           日付で見る用の月別・日別の件数
 *
 * クローラ用API (Authorization: Bearer <CRAWL_TOKEN>。未設定なら存在しないことにする)
 *   GET  /api/crawl/state      ブログごとの進み具合
 *   POST /api/crawl/targets    SNSスプシ由来の「どのブログ・テーマが誰か」を丸ごと差し替え
 *   POST /api/crawl/known      渡したIDのうち取り込み済みのものを返す
 *   POST /api/crawl/entries    記事を取り込む(bigram化はここでやる。正規化の実装を1か所に保つため)
 *   POST /api/crawl/blog       ブログの進み具合を更新
 *   POST /api/crawl/purge      ブログ1つ分のデータを削除(除外リスト・削除依頼用)
 *   GET  /api/crawl/checks     削除チェックの進み具合
 *   POST /api/crawl/check      削除チェックの進み具合を更新
 *   POST /api/crawl/range      ブログ内のID範囲にある取り込み済み記事のIDと編集日時
 *   POST /api/crawl/meta       取り込み済み記事に日時だけを書き足す
 *   POST /api/crawl/fix        crawler/fixes.tsv の例外指定を取り込み済みの記事に反映
 *   POST /api/crawl/delete     アメブロ側で消えた記事を削除
 *   POST /api/crawl/notify-test  Discord 通知のテスト送信
 *
 * それ以外は静的アセット(public/)へ。
 */

const MAX_Q = 100;          // クエリ長の上限
const MAX_TERMS = 5;        // 空白区切りの語数上限
const PAGE = 20;            // 1回に返す件数
const CTX = 40;             // スニペットの前後文字数
const MAX_SNIPPETS = 2;     // 1記事あたりのスニペット数
const INGEST_MAX = 50;      // 1リクエストで取り込む記事数の上限

/* ============================ 正規化・bigram ============================ */

// 索引と検索で完全に同じものを使う: NFKC→小文字→日本語(々〆・かな・漢字)と英数字以外を除去
const KEEP = /[0-9a-z\u3005\u3006\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u;
const DROP = /[^0-9a-z\u3005\u3006\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/gu;
const KANJI = /^[\u3005\u3006\u3400-\u4dbf\u4e00-\u9fff]$/u;

function normalize(s) {
  return (s || "").normalize("NFKC").toLowerCase().replace(DROP, "");
}

function bigramText(s) {
  const n = normalize(s);
  const out = [];
  for (let i = 0; i + 1 < n.length; i++) out.push(n.slice(i, i + 2));
  return out.join(" ");
}

// 検索語 → FTS5 のクエリ。語ごとに bigram のフレーズ(連続一致≒部分一致)にして AND で繋ぐ。
// 1文字は漢字だけ受け付け、その字で始まる bigram の前方一致にする(かな1文字は多すぎて重い)。
function buildMatch(q) {
  const terms = [];
  for (const raw of q.split(/[\s　]+/)) {
    const n = normalize(raw);
    if (!n || terms.includes(n)) continue;
    terms.push(n);
    if (terms.length >= MAX_TERMS) break;
  }
  const parts = [];
  for (const t of terms) {
    if (t.length === 1) {
      if (KANJI.test(t)) parts.push(`"${t}" *`);
    } else {
      const bg = [];
      for (let i = 0; i + 1 < t.length; i++) bg.push(t.slice(i, i + 2));
      parts.push(`"${bg.join(" ")}"`);
    }
  }
  if (!parts.length) return null;
  return { match: parts.join(" AND "), terms };
}

/* ============================ スニペット ============================ */

// 元の本文と正規化後の文字の対応表を作る(正規化後の i 文字目 = 元の map[i] 文字目から)
function normMap(body) {
  let norm = "";
  const map = [];
  for (let i = 0; i < body.length;) {
    const cp = body.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    for (const c of ch.normalize("NFKC").toLowerCase()) {
      if (KEEP.test(c)) {
        norm += c;
        map.push(i);
      }
    }
    i += ch.length;
  }
  return { norm, map };
}

function charEnd(body, i) {
  const cp = body.codePointAt(i);
  return i + (cp > 0xffff ? 2 : 1);
}

// サロゲートペアの途中で切らない
function safeCut(body, i) {
  if (i <= 0) return 0;
  if (i >= body.length) return body.length;
  const c = body.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

const squash = (s) => s.replace(/\s+/g, " ");

function snippets(body, terms) {
  if (!body) return [];
  const { norm, map } = normMap(body);
  const hits = [];
  for (const t of terms) {
    let from = 0;
    while (hits.length < 60) {
      const p = norm.indexOf(t, from);
      if (p < 0) break;
      hits.push([map[p], charEnd(body, map[p + t.length - 1])]);
      from = p + t.length;
    }
  }
  if (!hits.length) {
    // タイトルだけに一致した、など。冒頭を見せる
    const head = squash(body).trim();
    return head ? [{ pre: false, post: head.length > CTX * 2, parts: [{ t: head.slice(0, CTX * 2) }] }] : [];
  }
  hits.sort((a, b) => a[0] - b[0]);

  const out = [];
  let i = 0;
  while (i < hits.length && out.length < MAX_SNIPPETS) {
    const ws = safeCut(body, hits[i][0] - CTX);
    let we = safeCut(body, hits[i][1] + CTX);
    const inWin = [];
    while (i < hits.length && hits[i][0] < we) {
      if (!inWin.length || hits[i][0] >= inWin[inWin.length - 1][1]) inWin.push(hits[i]);
      we = Math.max(we, Math.min(body.length, hits[i][1]));
      i++;
    }
    const parts = [];
    let cur = ws;
    for (const [s, e] of inWin) {
      if (s > cur) parts.push({ t: squash(body.slice(cur, s)) });
      parts.push({ t: squash(body.slice(s, e)), h: 1 });
      cur = e;
    }
    if (we > cur) parts.push({ t: squash(body.slice(cur, we)) });
    out.push({ pre: ws > 0, post: we < body.length, parts });
  }
  return out;
}

/* ============================ 公開API ============================ */

function json(obj, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-robots-tag": "noindex, nofollow" },
  });
}

const entryUrl = (blog, id) => `https://ameblo.jp/${blog}/entry-${id}.html`;

async function handleSearch(url, env) {
  const q = url.searchParams.get("q") || "";
  // m は "12" でも "12,34,56"(メンバーの複数選択)でもよい
  const ms = (url.searchParams.get("m") || "").split(",")
    .map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)).slice(0, 300);
  const blog = (url.searchParams.get("b") || "").slice(0, 100);
  // 期間: "2016" / "2016-03" / "2016-03-05"。published の前方一致(〜 d+"~" 未満)で引く
  const dRaw = url.searchParams.get("d") || "";
  const d = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(dRaw) ? dRaw : "";
  const act = url.searchParams.get("act") === "1";
  const asc = url.searchParams.get("order") === "old";
  const cursor = parseInt(url.searchParams.get("cursor") || "", 10);

  // 文字数は見た目の1文字(絵文字も1)で数える
  if ([...q.trim()].length > MAX_Q) return json({ error: "long", max: MAX_Q, results: [], next: null });
  if (q.split(/[\s　]+/).filter(Boolean).length > MAX_TERMS) {
    return json({ error: "many", max: MAX_TERMS, results: [], next: null });
  }
  const built = q.trim() ? buildMatch(q) : null;
  if (q.trim() && !built) {
    // 正規化で全部消えた(記号・絵文字だけ) と、残ったが短すぎる(かな1文字など) を分けて返す
    const why = normalize(q) ? "short" : "empty";
    return json({ error: why, results: [], next: null });
  }
  // 語も絞り込みも無ければ、全ブログの新着をそのまま並べる(トップページ)

  const cols = "e.entry_id, e.blog, e.title, e.published, e.theme_id, e.theme_name, e.body, e.restricted, " +
    "mb.name AS member, b.title AS blog_title";
  // メンバーを名指ししているなら、現役かどうかの判定はもう要らない
  const needMeta = act && !ms.length;
  const joins = "LEFT JOIN members mb ON mb.member_no = e.member_no LEFT JOIN blogs b ON b.blog = e.blog" +
    (needMeta ? " JOIN member_meta mm ON mm.member_no = e.member_no" : "");
  const where = [];
  const binds = [];
  // 誰の記事か(メンバー・ブログ・現役)の絞り込み
  const narrow = () => {
    if (ms.length === 1) { where.push("e.member_no = ?"); binds.push(ms[0]); }
    else if (ms.length) { where.push(`e.member_no IN (${ms.map(() => "?").join(",")})`); binds.push(...ms); }
    if (blog) { where.push("e.blog = ?"); binds.push(blog); }
    if (needMeta) where.push("mm.active = 1");
  };
  let sql;

  if (built) {
    // entry_fts を外側に回し、rowid(=記事ID)順にLIMITで打ち切らせる。ヒット数が多い語でも全件は読まない
    where.push("entry_fts MATCH ?");
    binds.push(built.match);
    narrow();
    if (d) { where.push("e.published >= ? AND e.published < ?"); binds.push(d, d + "~"); }
    if (Number.isFinite(cursor)) { where.push(`entry_fts.rowid ${asc ? ">" : "<"} ?`); binds.push(cursor); }
    sql = `SELECT ${cols} FROM entry_fts JOIN entries e ON e.entry_id = entry_fts.rowid ${joins} ` +
      `WHERE ${where.join(" AND ")} ORDER BY entry_fts.rowid ${asc ? "ASC" : "DESC"} LIMIT ?`;
  } else {
    // 語なし: 絞り込みに合う記事を新しい順に並べる(新着一覧・カレンダーから日を選んだ時もこれ)
    narrow();
    if (d) { where.push("e.published >= ? AND e.published < ?"); binds.push(d, d + "~"); }
    if (Number.isFinite(cursor)) { where.push(`e.entry_id ${asc ? ">" : "<"} ?`); binds.push(cursor); }
    sql = `SELECT ${cols} FROM entries e ${joins} ` +
      (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
      `ORDER BY e.entry_id ${asc ? "ASC" : "DESC"} LIMIT ?`;
  }
  binds.push(PAGE + 1);

  let results;
  try {
    ({ results } = await env.DB.prepare(sql).bind(...binds).all());
  } catch (e) {
    return json({ error: "query", message: String(e && e.message || e), results: [], next: null }, 500);
  }

  const more = results.length > PAGE;
  const rows = results.slice(0, PAGE).map((r) => ({
    id: String(r.entry_id),
    url: entryUrl(r.blog, r.entry_id),
    title: r.title || "(無題)",
    date: (r.published || "").slice(0, 16).replace("T", " "),
    member: r.member || null,
    blog: r.blog,
    blog_title: shortTitle(r.blog_title) || r.blog,
    theme: r.theme_name || null,
    theme_url: r.theme_id ? `https://ameblo.jp/${r.blog}/theme-${r.theme_id}.html` : null,
    blog_url: `https://ameblo.jp/${r.blog}/`,
    restricted: !!r.restricted,
    snippets: snippets(r.body || "", built ? built.terms : []),
  }));
  return json({
    results: rows,
    next: more ? rows[rows.length - 1].id : null,
    terms: built ? built.terms : [],
  }, 200, "public, max-age=300");
}

// 日付で見る: メンバー(・ブログ)の月ごとの件数と、ym を渡せばその月の日ごとの件数
async function handleCalendar(url, env) {
  const m = parseInt(url.searchParams.get("m") || "", 10);
  if (!Number.isFinite(m)) return json({ months: [], days: [] });
  const blog = (url.searchParams.get("b") || "").slice(0, 100);
  const ymRaw = url.searchParams.get("ym") || "";
  const ym = /^\d{4}-\d{2}$/.test(ymRaw) ? ymRaw : "";
  const where = "member_no = ?" + (blog ? " AND blog = ?" : "");
  const binds = blog ? [m, blog] : [m];
  const stmts = [
    env.DB.prepare(
      `SELECT substr(published, 1, 7) AS ym, count(*) AS n FROM entries WHERE ${where} AND published IS NOT NULL ` +
      "GROUP BY ym ORDER BY ym"
    ).bind(...binds),
  ];
  if (ym) {
    stmts.push(env.DB.prepare(
      `SELECT substr(published, 1, 10) AS d, count(*) AS n FROM entries WHERE ${where} ` +
      "AND published >= ? AND published < ? GROUP BY d ORDER BY d"
    ).bind(...binds, ym, ym + "~"));
  }
  const res = await env.DB.batch(stmts);
  return json({
    months: res[0].results.map((r) => [r.ym, r.n]),
    days: ym ? res[1].results.map((r) => [r.d, r.n]) : [],
  }, 200, "public, max-age=300");
}

// 「スマイレージ 福田花音オフィシャルブログ「アイドル革命 いちごのツブログ season2」」→「アイドル革命 いちごのツブログ season2」
function shortTitle(t) {
  if (!t) return "";
  const q = t.match(/「(.+)」/);
  if (q) return q[1].trim();
  return t.replace(/Powered by Ameba/i, "").replace(/オフィシャルブログ|公式ブログ|official\s*blog/gi, "").trim() || t;
}

async function handleMembers(env) {
  const [{ results: rows }, { results: stats }, { results: groups }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT DISTINCT mb.member_no, mb.name, mm.groups, mm.active, t.blog, b.title, b.newest_id FROM members mb " +
      "JOIN targets t ON t.member_no = mb.member_no LEFT JOIN blogs b ON b.blog = t.blog " +
      "LEFT JOIN member_meta mm ON mm.member_no = mb.member_no " +
      "ORDER BY mb.member_no, b.newest_id DESC"
    ),
    env.DB.prepare(
      "SELECT count(*) AS blogs, sum(ingested) AS ingested, sum(total) AS total, " +
      "sum(done) AS done, max(updated_at) AS updated_at FROM blogs"
    ),
    env.DB.prepare("SELECT group_no, name FROM groups ORDER BY group_no"),
  ]);
  const members = [];
  for (const r of rows) {
    let mb = members[members.length - 1];
    if (!mb || mb.no !== r.member_no) {
      members.push(mb = {
        no: r.member_no,
        name: r.name,
        active: r.active ? 1 : 0,
        groups: (r.groups || "").split(",").filter(Boolean).map(Number),
        blogs: [],
      });
    }
    mb.blogs.push({ id: r.blog, title: shortTitle(r.title) || r.blog });
  }
  return json({
    members,
    groups: groups.map((r) => ({ no: r.group_no, name: r.name })),
    stats: stats[0] || {},
  }, 200, "public, max-age=300");
}

/* ============================ クローラ用API ============================ */

function authorized(request, env) {
  const token = env.CRAWL_TOKEN;
  if (!token) return false;
  const got = request.headers.get("authorization") || "";
  const want = `Bearer ${token}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const now = () => new Date().toISOString();

async function crawlState(env) {
  const { results } = await env.DB.prepare("SELECT * FROM blogs").all();
  return json({ blogs: results });
}

// targets を丸ごと差し替える。紐づけが変わった所だけ entries.member_no を付け直す
// (全件UPDATEは毎回数十万行読むことになるので、差分だけ)。
async function crawlTargets(request, env) {
  const { members = [], groups = [], targets = [] } = await request.json();
  const key = (t) => `${t.blog}\t${t.theme_id || ""}`;

  const { results: old } = await env.DB.prepare("SELECT blog, theme_id, member_no FROM targets").all();
  const before = new Map(old.map((t) => [key(t), t.member_no]));
  const after = new Map(targets.map((t) => [key(t), t.member_no ?? null]));

  const stmts = [env.DB.prepare("DELETE FROM members"), env.DB.prepare("DELETE FROM targets")];
  stmts.push(env.DB.prepare("DELETE FROM member_meta"), env.DB.prepare("DELETE FROM groups"));
  for (const mb of members) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO members (member_no, name) VALUES (?, ?)").bind(mb.member_no, mb.name));
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO member_meta (member_no, groups, active) VALUES (?, ?, ?)")
      .bind(mb.member_no, mb.groups || "", mb.active ? 1 : 0));
  }
  for (const g of groups) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO groups (group_no, name) VALUES (?, ?)").bind(g.group_no, g.name));
  }
  for (const t of targets) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO targets (blog, theme_id, member_no) VALUES (?, ?, ?)")
      .bind(t.blog, t.theme_id || "", t.member_no ?? null));
  }

  const changed = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(k) ?? null) !== (after.get(k) ?? null)) changed.push(k);
  }
  for (const k of changed) {
    const [blog, theme] = k.split("\t");
    const mno = after.get(k) ?? null;
    if (theme) {
      stmts.push(env.DB.prepare("UPDATE entries SET member_no = ? WHERE blog = ? AND theme_id = ?").bind(mno, blog, theme));
    } else {
      // 個人ブログ丸ごと。テーマ個別の指定がある記事はそちらを優先したいので、テーマ指定の無い記事だけ
      stmts.push(env.DB.prepare(
        "UPDATE entries SET member_no = ? WHERE blog = ? AND NOT EXISTS " +
        "(SELECT 1 FROM targets t WHERE t.blog = entries.blog AND t.theme_id = entries.theme_id)"
      ).bind(mno, blog));
    }
  }
  await env.DB.batch(stmts);
  return json({ ok: true, members: members.length, targets: targets.length, remapped: changed.length });
}

async function crawlKnown(request, env) {
  const { ids = [] } = await request.json();
  const nums = ids.map(Number).filter(Number.isFinite).slice(0, 90);
  if (!nums.length) return json({ known: [] });
  const { results } = await env.DB
    .prepare(`SELECT entry_id FROM entries WHERE entry_id IN (${nums.map(() => "?").join(",")})`)
    .bind(...nums).all();
  return json({ known: results.map((r) => String(r.entry_id)) });
}

async function crawlEntries(request, env, ctx) {
  const { entries = [] } = await request.json();
  if (!entries.length) return json({ ok: true, inserted: 0 });
  if (entries.length > INGEST_MAX) return json({ error: "too_many" }, 400);

  const ids = entries.map((e) => Number(e.entry_id));
  const blogs = [...new Set(entries.map((e) => e.blog))];
  const [{ results: known }, { results: tg }] = await env.DB.batch([
    env.DB.prepare(`SELECT entry_id FROM entries WHERE entry_id IN (${ids.map(() => "?").join(",")})`).bind(...ids),
    env.DB.prepare(`SELECT blog, theme_id, member_no FROM targets WHERE blog IN (${blogs.map(() => "?").join(",")})`).bind(...blogs),
  ]);
  const exists = new Set(known.map((r) => Number(r.entry_id)));
  const map = new Map(tg.map((t) => [`${t.blog}\t${t.theme_id}`, t.member_no]));
  const memberOf = (e) => {
    // クローラが例外指定(fixes.tsv)で決めた書き手があれば、対応表より優先する
    if (e.member_no !== undefined) return e.member_no === null ? null : Number(e.member_no);
    const k = `${e.blog}\t${e.theme_id || ""}`;
    if (map.has(k)) return map.get(k);
    return map.get(`${e.blog}\t`) ?? null;
  };

  const ts = now();
  const stmts = [];
  const added = {};
  const edited = [];
  for (const e of entries) {
    const id = Number(e.entry_id);
    if (exists.has(id)) {
      stmts.push(env.DB.prepare("DELETE FROM entry_fts WHERE rowid = ?").bind(id));
      edited.push(e);   // 取り込み済みの記事が来た = 編集されたので入れ直す
    } else {
      added[e.blog] = (added[e.blog] || 0) + 1;
    }
    stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO entries (entry_id, blog, theme_id, theme_name, member_no, title, published, body, " +
      "edited, ins_datetime, upd_datetime, publish_flg, restricted, fetched_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, e.blog, String(e.theme_id || ""), e.theme_name || null, memberOf(e), e.title || "",
      e.published || null, e.body || "", e.edited || null, e.ins_datetime || null, e.upd_datetime || null,
      e.publish_flg || null, e.restricted ? 1 : 0, ts));
    stmts.push(env.DB.prepare("INSERT INTO entry_fts (rowid, title, body) VALUES (?, ?, ?)")
      .bind(id, bigramText(e.title), bigramText(e.body)));
  }
  for (const [blog, n] of Object.entries(added)) {
    stmts.push(env.DB.prepare(
      "INSERT INTO blogs (blog, ingested, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(blog) DO UPDATE SET ingested = ingested + excluded.ingested, updated_at = excluded.updated_at"
    ).bind(blog, n, ts));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // 無料枠の上限(容量500MB・1日の書き込み数)に当たった。クローラには「今日はここまで」と伝える
    const msg = String((e && e.message) || e);
    if (/limit|exceed|quota|full|too big|SQLITE_FULL/i.test(msg)) return json({ error: "db_limit", message: msg }, 507);
    throw e;
  }
  if (edited.length && env.DISCORD_WEBHOOK) {
    const lines = edited.slice(0, 10)
      .map((e) => `・[${e.title || "(無題)"}](${entryUrl(e.blog, e.entry_id)})`).join("\n");
    ctx.waitUntil(notifyDiscord(env, `記事が編集されたので入れ直しました（${edited.length}件）`,
      lines + (edited.length > 10 ? `\nほか${edited.length - 10}件` : "")));
  }
  return json({ ok: true, inserted: Object.values(added).reduce((a, b) => a + b, 0), replaced: exists.size });
}

// 削除チェック: ブログ内のID範囲 [lo, hi) にある取り込み済み記事のID
async function crawlRange(request, env) {
  const { blog, lo, hi } = await request.json();
  const where = ["blog = ?", "entry_id >= ?"];
  const binds = [blog, Number(lo) || 0];
  if (hi != null) { where.push("entry_id < ?"); binds.push(Number(hi)); }
  const { results } = await env.DB
    .prepare(`SELECT entry_id, edited FROM entries WHERE ${where.join(" AND ")} LIMIT 1000`)
    .bind(...binds).all();
  return json({ rows: results.map((r) => ({ id: String(r.entry_id), edited: r.edited || "" })) });
}

// タイトルの署名で書き手を決める。名前が複数出てくるときは後ろにある方(署名はふつう末尾)
function byTitle(title, rules, fallback) {
  const t = (title || "").toLowerCase();
  let best = null, at = -1, len = 0;
  for (const r of rules) {
    const i = t.lastIndexOf(r.key);
    if (i < 0) continue;
    if (i > at || (i === at && r.key.length > len)) { best = r.member_no; at = i; len = r.key.length; }
  }
  return best === null ? fallback : best;
}

// crawler/fixes.tsv の例外指定を、取り込み済みの記事に反映する
async function crawlFix(request, env) {
  const { themes = [], entries = [], titles = [], defaults = {} } = await request.json();
  const stmts = [];
  const blogs = new Set();
  let removed = 0;

  for (const t of themes) {
    blogs.add(t.blog);
    if (t.member_no === null) {
      stmts.push(env.DB.prepare(
        "DELETE FROM entry_fts WHERE rowid IN (SELECT entry_id FROM entries WHERE blog = ? AND theme_id = ?)"
      ).bind(t.blog, String(t.theme_id)));
      stmts.push(env.DB.prepare("DELETE FROM entries WHERE blog = ? AND theme_id = ?")
        .bind(t.blog, String(t.theme_id)));
      removed++;
    } else {
      stmts.push(env.DB.prepare("UPDATE entries SET member_no = ? WHERE blog = ? AND theme_id = ? AND member_no IS NOT ?")
        .bind(t.member_no, t.blog, String(t.theme_id), t.member_no));
    }
  }

  const del = entries.filter((e) => e.member_no === null).map((e) => Number(e.entry_id));
  // 消す記事がどのブログのものかを先に控えておく(あとで件数を数え直すため)
  for (let i = 0; i < del.length; i += 90) {
    const ids = del.slice(i, i + 90);
    const { results } = await env.DB
      .prepare(`SELECT DISTINCT blog FROM entries WHERE entry_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all();
    for (const r of results) blogs.add(r.blog);
  }
  for (let i = 0; i < del.length; i += 90) {
    const ids = del.slice(i, i + 90);
    const ph = ids.map(() => "?").join(",");
    stmts.push(env.DB.prepare(`DELETE FROM entry_fts WHERE rowid IN (${ph})`).bind(...ids));
    stmts.push(env.DB.prepare(`DELETE FROM entries WHERE entry_id IN (${ph})`).bind(...ids));
  }
  for (const e of entries) {
    if (e.member_no === null) continue;
    stmts.push(env.DB.prepare("UPDATE entries SET member_no = ? WHERE entry_id = ? AND member_no IS NOT ?")
      .bind(Number(e.member_no), Number(e.entry_id), Number(e.member_no)));
  }

  // タイトルで決める指定。まだその指定で決まっていない記事だけを見る(2回目以降はほぼ0件)
  let retitled = 0;
  const byBlog = new Map();
  for (const r of titles) {
    if (!byBlog.has(r.blog)) byBlog.set(r.blog, []);
    byBlog.get(r.blog).push({ key: String(r.key).toLowerCase(), member_no: Number(r.member_no) });
  }
  for (const [blog, rules] of byBlog) {
    blogs.add(blog);
    const mine = [...new Set(rules.map((r) => r.member_no))];
    const fallback = blog in defaults ? defaults[blog] : undefined;
    const ph = mine.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT entry_id, title, member_no FROM entries WHERE blog = ? ` +
      `AND (member_no IS NULL OR member_no NOT IN (${ph})) LIMIT 3000`
    ).bind(blog, ...mine).all();
    for (const row of results) {
      const who = byTitle(row.title, rules, fallback);
      if (who === undefined || who === row.member_no) continue;   // 指定なし・変化なしは触らない
      stmts.push(env.DB.prepare("UPDATE entries SET member_no = ? WHERE entry_id = ?")
        .bind(who === null ? null : who, row.entry_id));
      retitled++;
    }
  }

  if (!stmts.length) return json({ ok: true, removed: 0, retitled: 0 });
  // 件数の集計は消したあとに数え直す
  for (const b of blogs) {
    stmts.push(env.DB.prepare(
      "UPDATE blogs SET ingested = (SELECT count(*) FROM entries WHERE entries.blog = blogs.blog) WHERE blog = ?"
    ).bind(b));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  return json({ ok: true, removed, retitled, statements: stmts.length });
}

// 取り込み済みの記事に、一覧で読めた日時だけを書き足す(本文は取り直さない)
async function crawlMeta(request, env) {
  const { rows = [] } = await request.json();
  if (!rows.length) return json({ ok: true, updated: 0 });
  if (rows.length > 100) return json({ error: "too_many" }, 400);
  await env.DB.batch(rows.map((r) => env.DB.prepare(
    "UPDATE entries SET edited = ?, ins_datetime = ?, upd_datetime = ?, publish_flg = ? WHERE entry_id = ?"
  ).bind(r.edited || null, r.ins_datetime || null, r.upd_datetime || null, r.publish_flg || null, Number(r.entry_id))));
  return json({ ok: true, updated: rows.length });
}

async function crawlChecks(env) {
  const { results } = await env.DB.prepare("SELECT * FROM checks").all();
  return json({ checks: results });
}

async function crawlCheck(request, env) {
  const c = await request.json();
  await env.DB.prepare(
    "INSERT INTO checks (blog, page, prev_min, cycles, updated_at) VALUES (?1, ?2, ?3, coalesce(?4, 0), ?5) " +
    "ON CONFLICT(blog) DO UPDATE SET page = ?2, prev_min = ?3, cycles = cycles + coalesce(?4, 0), updated_at = ?5"
  ).bind(c.blog, c.page, c.prev_min ?? null, c.cycle_done ? 1 : 0, now()).run();
  return json({ ok: true });
}

// アメブロ側で消えた(または非公開になった)記事を消す
async function crawlDelete(request, env) {
  const { ids = [] } = await request.json();
  const nums = ids.map(Number).filter(Number.isFinite).slice(0, 90);
  if (!nums.length) return json({ ok: true, deleted: 0 });
  const ph = nums.map(() => "?").join(",");
  const { results: gone } = await env.DB.prepare(
    `SELECT entry_id, blog, title, published FROM entries WHERE entry_id IN (${ph}) ORDER BY entry_id DESC`
  ).bind(...nums).all();
  // 消す前に必ず知らせる(あとから取り返せないため)
  if (gone.length && env.DISCORD_WEBHOOK) {
    const lines = gone.slice(0, 20).map((r) =>
      `・${(r.published || "").slice(0, 10)} [${r.title || "(無題)"}](${entryUrl(r.blog, r.entry_id)})`).join("\n");
    await notifyDiscord(env, `アメブロ側で消えた記事を削除します（${gone.length}件）`,
      lines + (gone.length > 20 ? `\nほか${gone.length - 20}件` : ""));
  }
  const { results } = await env.DB
    .prepare(`SELECT blog, count(*) AS n FROM entries WHERE entry_id IN (${ph}) GROUP BY blog`).bind(...nums).all();
  const stmts = [
    env.DB.prepare(`DELETE FROM entry_fts WHERE rowid IN (${ph})`).bind(...nums),
    env.DB.prepare(`DELETE FROM entries WHERE entry_id IN (${ph})`).bind(...nums),
  ];
  for (const r of results) {
    stmts.push(env.DB.prepare("UPDATE blogs SET ingested = max(0, ingested - ?) WHERE blog = ?").bind(r.n, r.blog));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, deleted: results.reduce((a, r) => a + r.n, 0) });
}

// 除外リストに載ったブログのデータを消す(削除依頼への対応もこれ)
async function crawlPurge(request, env) {
  const { blog } = await request.json();
  if (!blog) return json({ error: "blog" }, 400);
  const { results } = await env.DB.prepare("SELECT count(*) AS n FROM entries WHERE blog = ?").bind(blog).all();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM entry_fts WHERE rowid IN (SELECT entry_id FROM entries WHERE blog = ?)").bind(blog),
    env.DB.prepare("DELETE FROM entries WHERE blog = ?").bind(blog),
    env.DB.prepare("DELETE FROM blogs WHERE blog = ?").bind(blog),
    env.DB.prepare("DELETE FROM checks WHERE blog = ?").bind(blog),
  ]);
  return json({ ok: true, deleted: results[0].n });
}

async function crawlBlog(request, env) {
  const b = await request.json();
  if (!b.blog) return json({ error: "blog" }, 400);
  await env.DB.prepare(
    "INSERT INTO blogs (blog, title, total, newest_id, cursor_page, done, updated_at) VALUES (?1, ?2, ?3, ?4, coalesce(?5, 1), coalesce(?6, 0), ?7) " +
    "ON CONFLICT(blog) DO UPDATE SET title = coalesce(?2, title), total = coalesce(?3, total), " +
    "newest_id = coalesce(?4, newest_id), cursor_page = coalesce(?5, cursor_page), done = coalesce(?6, done), updated_at = ?7"
  ).bind(b.blog, b.title ?? null, b.total ?? null, b.newest_id ?? null, b.cursor_page ?? null,
    b.done == null ? null : (b.done ? 1 : 0), now()).run();
  return json({ ok: true });
}

/* ============================ ルーティング ============================ */

// 同じURLの結果は数分キャッシュする(誰が見ても同じ内容なので共有して問題ない)。
// D1 を引く回数が減り、同じ検索を繰り返し叩かれても負荷が増えない。
async function cached(request, ctx, build) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("x-cache", "hit");   // キャッシュが効いているか外から確かめるための印
    return r;
  }
  const res = await build();
  if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

/* ============================ 定期実行 ============================ */

// 毎時、GitHub Actions のクロールを起動する。
// GitHub の schedule は混雑時に遅れたり飛ばされたりするので、起動だけ Cloudflare の Cron Triggers に任せる。
// 実行中に次の起動が来ても、crawl.yml の concurrency で順番待ちになるだけ。
const CRAWL_WORKFLOW = "https://api.github.com/repos/yxmxgxn/hello-ameblo/actions/workflows/crawl.yml/dispatches";

async function dispatchCrawl(env) {
  if (!env.GH_TOKEN) {
    console.log("GH_TOKEN 未設定のためクロールを起動しない");
    return;
  }
  const r = await fetch(CRAWL_WORKFLOW, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "hello-ameblo-cron",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) console.log("クロールの起動に失敗", r.status, (await r.text()).slice(0, 300));
}

// クロールが止まっていたら Discord に知らせる。
// 起動されない・途中で落ち続ける、は GitHub の失敗メールでは気づけないので、D1 の最終更新時刻で見る。
// 状態を持たずに済むよう、止まって3時間目と24時間目の1時間だけ送る(毎時送り続けない)。
async function notifyDiscord(env, title, description) {
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "アメブロ検索",  // ウェブフックは karin と共用。送り主の表示だけ変える
      embeds: [{ title, description, url: "https://github.com/yxmxgxn/hello-ameblo/actions", color: 0x2d8c3c }],
    }),
  });
}

async function checkStalled(env) {
  if (!env.DISCORD_WEBHOOK) return;
  const row = await env.DB.prepare("SELECT max(updated_at) AS t FROM blogs").first();
  if (!row || !row.t) return;
  const hours = (Date.now() - Date.parse(row.t)) / 3600e3;
  if (!((hours >= 3 && hours < 4) || (hours >= 24 && hours < 25))) return;
  const jst = new Date(Date.parse(row.t) + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  await notifyDiscord(env, "クロールが止まっています",
    `最後に動いたのは ${jst}（日本時間）。${Math.floor(hours)}時間動いていません。
` +
    "GitHub の Actions（Crawl）と、Worker の GH_TOKEN の期限を確認してください。");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchCrawl(env));
    ctx.waitUntil(checkStalled(env).catch((e) => console.log("停止チェック失敗", String(e))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 公開API: 同一IPからの叩きすぎを止める(workers.dev では WAF が使えないので Worker 側で)
    if (p.startsWith("/api/") && !p.startsWith("/api/crawl/") && env.RL) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429, "no-store");
    }

    if (p === "/api/search" && request.method === "GET") return cached(request, ctx, () => handleSearch(url, env));
    if (p === "/api/members" && request.method === "GET") return cached(request, ctx, () => handleMembers(env));
    if (p === "/api/calendar" && request.method === "GET") return cached(request, ctx, () => handleCalendar(url, env));

    if (p.startsWith("/api/crawl/")) {
      if (!authorized(request, env)) return new Response("Not found", { status: 404 });
      try {
        return await crawlRoute(request, env, p, ctx);
      } catch (e) {
        // 例外のままだと Cloudflare の汎用エラー(1101)になって原因が分からないので中身を返す
        const msg = String((e && e.message) || e);
        if (/limit|exceed|quota|full|too big|SQLITE_FULL/i.test(msg)) return json({ error: "db_limit", message: msg }, 507);
        return json({ error: "crawl", message: msg }, 500);
      }
    }

    if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

async function crawlRoute(request, env, p, ctx) {
  {
    {
      const route = `${request.method} ${p.slice("/api/crawl/".length)}`;
      if (route === "GET state") return crawlState(env);
      if (route === "POST targets") return crawlTargets(request, env);
      if (route === "POST known") return crawlKnown(request, env);
      if (route === "POST entries") return crawlEntries(request, env, ctx);
      if (route === "POST blog") return crawlBlog(request, env);
      if (route === "POST purge") return crawlPurge(request, env);
      if (route === "GET checks") return crawlChecks(env);
      if (route === "POST check") return crawlCheck(request, env);
      if (route === "POST range") return crawlRange(request, env);
      if (route === "POST meta") return crawlMeta(request, env);
      if (route === "POST fix") return crawlFix(request, env);
      if (route === "POST delete") return crawlDelete(request, env);
      if (route === "POST notify-test") {
        if (!env.DISCORD_WEBHOOK) return json({ error: "DISCORD_WEBHOOK 未設定" }, 400);
        await notifyDiscord(env, "通知のテスト", "クロールが止まったときは、ここにこの形で届きます。");
        return json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    }
  }
}
