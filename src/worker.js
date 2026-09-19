/**
 * アメブロ検索 Worker (Static Assets 併用)
 *
 * 公開API
 *   GET /api/search?q=&m=&b=&d=&order=&cursor=  本文・タイトルの全文検索。前後数十字だけ返し、本文全体は返さない
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
 *   POST /api/crawl/range      ブログ内のID範囲にある取り込み済み記事のID
 *   POST /api/crawl/delete     アメブロ側で消えた記事を削除
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
  for (const raw of q.slice(0, MAX_Q).split(/[\s　]+/)) {
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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}

const entryUrl = (blog, id) => `https://ameblo.jp/${blog}/entry-${id}.html`;

async function handleSearch(url, env) {
  const q = url.searchParams.get("q") || "";
  const m = parseInt(url.searchParams.get("m") || "", 10);
  const blog = (url.searchParams.get("b") || "").slice(0, 100);
  // 期間: "2016" / "2016-03" / "2016-03-05"。published の前方一致(〜 d+"~" 未満)で引く
  const dRaw = url.searchParams.get("d") || "";
  const d = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(dRaw) ? dRaw : "";
  const asc = url.searchParams.get("order") === "old";
  const cursor = parseInt(url.searchParams.get("cursor") || "", 10);

  const built = q.trim() ? buildMatch(q) : null;
  if (q.trim() && !built) return json({ error: "short", results: [], next: null });
  if (!built && !Number.isFinite(m) && !d) return json({ results: [], next: null });

  const cols = "e.entry_id, e.blog, e.title, e.published, e.theme_name, e.body, e.restricted, " +
    "mb.name AS member, b.title AS blog_title";
  const joins = "LEFT JOIN members mb ON mb.member_no = e.member_no LEFT JOIN blogs b ON b.blog = e.blog";
  const where = [];
  const binds = [];
  let sql;

  if (built) {
    // entry_fts を外側に回し、rowid(=記事ID)順にLIMITで打ち切らせる。ヒット数が多い語でも全件は読まない
    where.push("entry_fts MATCH ?");
    binds.push(built.match);
    if (Number.isFinite(m)) { where.push("e.member_no = ?"); binds.push(m); }
    if (blog) { where.push("e.blog = ?"); binds.push(blog); }
    if (d) { where.push("e.published >= ? AND e.published < ?"); binds.push(d, d + "~"); }
    if (Number.isFinite(cursor)) { where.push(`entry_fts.rowid ${asc ? ">" : "<"} ?`); binds.push(cursor); }
    sql = `SELECT ${cols} FROM entry_fts JOIN entries e ON e.entry_id = entry_fts.rowid ${joins} ` +
      `WHERE ${where.join(" AND ")} ORDER BY entry_fts.rowid ${asc ? "ASC" : "DESC"} LIMIT ?`;
  } else {
    // 語なし: メンバー・期間で絞った記事を並べる(カレンダーから日を選んだ時もこれ)
    if (Number.isFinite(m)) { where.push("e.member_no = ?"); binds.push(m); }
    if (blog) { where.push("e.blog = ?"); binds.push(blog); }
    if (d) { where.push("e.published >= ? AND e.published < ?"); binds.push(d, d + "~"); }
    if (Number.isFinite(cursor)) { where.push(`e.entry_id ${asc ? ">" : "<"} ?`); binds.push(cursor); }
    sql = `SELECT ${cols} FROM entries e ${joins} WHERE ${where.join(" AND ")} ` +
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
  const [{ results: rows }, { results: stats }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT DISTINCT mb.member_no, mb.name, t.blog, b.title, b.newest_id FROM members mb " +
      "JOIN targets t ON t.member_no = mb.member_no LEFT JOIN blogs b ON b.blog = t.blog " +
      "ORDER BY mb.member_no, b.newest_id DESC"
    ),
    env.DB.prepare(
      "SELECT count(*) AS blogs, sum(ingested) AS ingested, sum(total) AS total, " +
      "sum(done) AS done, max(updated_at) AS updated_at FROM blogs"
    ),
  ]);
  const members = [];
  for (const r of rows) {
    let mb = members[members.length - 1];
    if (!mb || mb.no !== r.member_no) members.push(mb = { no: r.member_no, name: r.name, blogs: [] });
    mb.blogs.push({ id: r.blog, title: shortTitle(r.title) || r.blog });
  }
  return json({ members, stats: stats[0] || {} }, 200, "public, max-age=300");
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
  const { members = [], targets = [] } = await request.json();
  const key = (t) => `${t.blog}\t${t.theme_id || ""}`;

  const { results: old } = await env.DB.prepare("SELECT blog, theme_id, member_no FROM targets").all();
  const before = new Map(old.map((t) => [key(t), t.member_no]));
  const after = new Map(targets.map((t) => [key(t), t.member_no ?? null]));

  const stmts = [env.DB.prepare("DELETE FROM members"), env.DB.prepare("DELETE FROM targets")];
  for (const mb of members) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO members (member_no, name) VALUES (?, ?)").bind(mb.member_no, mb.name));
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

async function crawlEntries(request, env) {
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
    const k = `${e.blog}\t${e.theme_id || ""}`;
    if (map.has(k)) return map.get(k);
    return map.get(`${e.blog}\t`) ?? null;
  };

  const ts = now();
  const stmts = [];
  const added = {};
  for (const e of entries) {
    const id = Number(e.entry_id);
    if (exists.has(id)) stmts.push(env.DB.prepare("DELETE FROM entry_fts WHERE rowid = ?").bind(id));
    else added[e.blog] = (added[e.blog] || 0) + 1;
    stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO entries (entry_id, blog, theme_id, theme_name, member_no, title, published, body, restricted, fetched_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, e.blog, String(e.theme_id || ""), e.theme_name || null, memberOf(e), e.title || "",
      e.published || null, e.body || "", e.restricted ? 1 : 0, ts));
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
  return json({ ok: true, inserted: Object.values(added).reduce((a, b) => a + b, 0), replaced: exists.size });
}

// 削除チェック: ブログ内のID範囲 [lo, hi) にある取り込み済み記事のID
async function crawlRange(request, env) {
  const { blog, lo, hi } = await request.json();
  const where = ["blog = ?", "entry_id >= ?"];
  const binds = [blog, Number(lo) || 0];
  if (hi != null) { where.push("entry_id < ?"); binds.push(Number(hi)); }
  const { results } = await env.DB
    .prepare(`SELECT entry_id FROM entries WHERE ${where.join(" AND ")} LIMIT 1000`)
    .bind(...binds).all();
  return json({ ids: results.map((r) => String(r.entry_id)) });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/search" && request.method === "GET") return handleSearch(url, env);
    if (p === "/api/members" && request.method === "GET") return handleMembers(env);
    if (p === "/api/calendar" && request.method === "GET") return handleCalendar(url, env);

    if (p.startsWith("/api/crawl/")) {
      if (!authorized(request, env)) return new Response("Not found", { status: 404 });
      const route = `${request.method} ${p.slice("/api/crawl/".length)}`;
      if (route === "GET state") return crawlState(env);
      if (route === "POST targets") return crawlTargets(request, env);
      if (route === "POST known") return crawlKnown(request, env);
      if (route === "POST entries") return crawlEntries(request, env);
      if (route === "POST blog") return crawlBlog(request, env);
      if (route === "POST purge") return crawlPurge(request, env);
      if (route === "GET checks") return crawlChecks(env);
      if (route === "POST check") return crawlCheck(request, env);
      if (route === "POST range") return crawlRange(request, env);
      if (route === "POST delete") return crawlDelete(request, env);
      return new Response("Not found", { status: 404 });
    }

    if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
