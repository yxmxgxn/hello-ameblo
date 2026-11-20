(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("f"), qEl = $("q"), actEl = $("act"), orderEl = $("order");
  const statusEl = $("status"), list = $("results"), moreBtn = $("more");
  const calEl = $("cal"), yearsEl = $("years"), monthEl = $("month");
  const panel = $("panel"), openBtn = $("pick-open"), pickLabel = $("pick-label");
  const glist = $("glist"), mlist = $("mlist"), chipsEl = $("chips");
  const msearch = $("msearch"), mcount = $("mcount");

  let current = null;       // 表示中の条件 {q, m, b, act, d, from, to, order}。d は押して選んだ月・日、from / to はいつから・いつまで
  let cursor = null;
  let busy = false;
  let cal = null;           // 日付で見る: {key, months: Map(ym→件数), ym, days: Map(日→件数)}
  let allMembers = [], allGroups = [], allBlogs = [];
  const picked = new Set(); // 選択中のメンバー番号。グループを押すとまとめて入る
  let blogPick = "";        // 1人だけ選んだ時の、その人のブログ別指定。誰も選んでいなければ「ブログだけで絞る」指定
  let byKana = false;       // メンバーの並び: false=グループ順(既定) / true=あいうえお順
  let gView = null;         // メンバー一覧をどのグループに絞って見せているか(null=すべて)。選択とは別
  let hold = null;          // 選ぶたびに叩かないよう少し待つ

  const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
  // 1人だけ選んで語が無いときのタブのタイトル。/?m=番号 を開いたとき Worker が書くのと同じ(public/site.json)
  // 名簿より先に読み終えておく(下の fromUrl は両方そろってから)。間に合わないと、Worker が書いた
  // その人のタイトルを「ハロプロ アメブロ検索」で上書きしてしまい、Google が本文から変なタイトルを作る
  let site = null;
  const siteReady = fetch("/site.json").then((r) => r.json()).then((s) => { site = s; }).catch(() => {});
  function memberTitle(c) {
    if (!site || !c.m || c.m.includes(",")) return "";
    const m = allMembers.find((x) => x.no === Number(c.m));
    if (!m) return "";
    return site.member_title.replace("{who}", m.kana ? `${m.name}（${m.kana}）` : m.name);
  }

  // サーバー(src/worker.js の MAX_Q / MAX_TERMS)と同じ上限
  const MAX_Q = 100, MAX_TERMS = 5;
  const WHY = {
    short: "検索語が短すぎます（ひらがな・カタカナ・英数字は2文字以上。漢字は1文字から）",
    long: `検索語が長すぎます（${MAX_Q}文字まで）`,
    many: `区切った語が多すぎます（${MAX_TERMS}語まで）`,
    empty: "検索に使える文字がありません（記号・絵文字は検索に使えません）",
    notonly: "「-」の付いた語（含まない語）だけでは探せません。含む語と一緒に使ってください",
  };
  // 送る前に分かる理由。長い語はURLにも履歴にも残さない
  function tooMuch(q) {
    if ([...q].length > MAX_Q) return "long";
    if (q.split(/[\s　]+/).filter(Boolean).length > MAX_TERMS) return "many";
    return null;
  }
  // 日本時間の今日。新着に NEW を付けるのに使う
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }

  // "2016" / "2016-03" / "2016-03-05" → 表示用
  function periodLabel(d) {
    const [y, m, day] = d.split("-");
    return `${y}年` + (m ? `${+m}月` : "") + (day ? `${+day}日` : "");
  }

  const memberOf = (no) => allMembers.find((m) => m.no === no);

  // ブログの表示名。1人だけのブログは「名前（ブログ名）」、何人かで書くブログはブログ名だけ。
  // ブログ名の引用符は半角の「'」にそろえる(「モーニング娘。‘26」「モーニング娘。’26」が混ざっているため)。
  // 同じ名前のブログが2つあるとき(つばきファクトリーの旧・新)は、ブログのIDを添えて区別する
  const tidy = (s) => String(s || "").replace(/[‘’]/g, "'");
  const writersOf = (id) => allMembers.filter((m) => m.blogs.some((b) => b.id === id));
  function blogName(id) {
    const b = allBlogs.find((x) => x.id === id);
    const w = writersOf(id);
    const title = tidy(b ? b.title : id);
    if (w.length === 1) return `${w[0].name}（${title}）`;
    const same = allBlogs.filter((x) => tidy(x.title) === title && writersOf(x.id).length !== 1).length > 1;
    return same ? `${title}（${id}）` : title;
  }

  // いまの条件を文章にする(「チャーハン ／ 竹内朱莉・田村芽実 ／ 2016年」)。何で絞っているかを画面に出すため
  function condText(c) {
    const parts = [];
    if (c.q) parts.push(`「${c.q}」`);
    const names = (c.m ? c.m.split(",") : []).map(Number).map(memberOf).filter(Boolean).map((m) => m.name);
    if (names.length) {
      let who = names.length > 3 ? `${names.slice(0, 3).join("・")} ほか${names.length - 3}人` : names.join("・");
      const s = names.length === 1 && c.b ? memberOf(Number(c.m)).blogs.find((b) => b.id === c.b) : null;
      if (s) who += `（${s.title}）`;
      parts.push(who);
    } else if (c.b) {
      parts.push(`ブログ: ${blogName(c.b)}`);
    } else if (c.act) {
      parts.push("ハロプロ現役のみ");
    }
    if (c.d) parts.push(periodLabel(c.d));
    else if (c.from || c.to) parts.push(`${c.from ? periodLabel(c.from) : ""}〜${c.to ? periodLabel(c.to) : ""}`);
    return parts.join(" ／ ");
  }
  // 検索語以外の絞り込みがあるか(0件のとき、絞り込みのせいかを確かめるため)
  const narrowed = (c) => !!(c.m || c.b || c.d || c.from || c.to || c.act);
  let blogNote = false;   // 2人目を足してブログの指定が外れたことを、次の表示で一度だけ知らせる

  // 0件のとき: 絞り込みを全部外して1件でもあるかだけ見る。どの記事にも無いのか、条件で外れたのかを分けて出す
  async function explainEmpty(c) {
    const cond = condText(c);
    if (!c.q || !narrowed(c)) {
      statusEl.textContent = c.q ? `「${c.q}」はどの記事にもありません` : `${cond ? cond + " ／ " : ""}記事がありません`;
      return;
    }
    statusEl.textContent = `${cond} ／ 0 件（ほかの条件で確かめています…）`;
    let found = false;
    try {
      const d = await (await fetch("/api/search?" + new URLSearchParams({ q: c.q, act: "0" }))).json();
      found = !!(d.results && d.results.length);
    } catch { /* 確かめられなければ 0 件とだけ出す */ }
    if (current !== c) return;   // 待っている間に条件が変わった
    if (!found) {
      statusEl.textContent = `「${c.q}」はどの記事にもありません`;
      return;
    }
    statusEl.replaceChildren(`${cond} ／ 0 件。メンバー・期間などの絞り込みを外すと見つかります。`,
      el("button", {
        type: "button", class: "ghost inline",
        onclick: () => {
          picked.clear();
          blogPick = "";
          actEl.checked = false;
          current = { ...current, d: "", from: "", to: "" };
          drawChips();
          drawPanel();
          search(true, false);
        },
      }, "絞り込みを外して検索"));
  }
  // 現役のみの指定に合う人だけを選択の対象にする
  const pool = () => allMembers.filter((m) => !actEl.checked || m.active);
  const inGroup = (g) => pool().filter((m) => m.groups.includes(g.no));
  const solo = () => (picked.size === 1 ? memberOf([...picked][0]) : null);

  /* ---------------- 検索結果 ---------------- */

  function render(r) {
    const meta = el("p", { class: "meta" },
      r.date.slice(0, 10) === today ? el("span", { class: "new" }, "NEW") : null,
      el("time", {}, r.date),
      el("span", { class: "who" }, r.member || tidy(r.blog_title)),
      // ブログのトップと、その人のテーマ(グループブログの中の個人ページ)へ飛べるようにする
      r.blog_title !== r.member
        ? el("a", { href: r.blog_url, target: "_blank", rel: "noopener noreferrer" }, tidy(r.blog_title))
        : null,
      r.theme_url ? el("a", { href: r.theme_url, target: "_blank", rel: "noopener noreferrer" }, `テーマ：${r.theme}`) : null);

    const li = el("li", {},
      el("h2", {}, el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.title)),
      meta);

    for (const s of r.snippets) {
      const p = el("p", { class: "snip" });
      if (s.pre) p.append(el("span", { class: "ell" }, "…"));
      for (const part of s.parts) p.append(part.h ? el("mark", {}, part.t) : part.t);
      if (s.post) p.append(el("span", { class: "ell" }, "…"));
      li.append(p);
    }
    if (!r.snippets.length && current.q) li.append(el("p", { class: "locked" }, "本文なし（画像・埋め込みのみ）"));
    return li;
  }

  function queryParams(c) {
    const p = new URLSearchParams();
    if (c.q) p.set("q", c.q);
    if (c.m) p.set("m", c.m);
    if (c.b) p.set("b", c.b);
    p.set("act", c.act ? "1" : "0");
    if (c.d) p.set("d", c.d);
    if (c.from) p.set("from", c.from);
    if (c.to) p.set("to", c.to);
    if (c.order) p.set("order", c.order);
    return p;
  }

  // 共有・履歴用のURL。既定(現役のみ)は書かずに短くする
  function shareParams(c) {
    const p = queryParams(c);
    if (c.act) p.delete("act");
    return p;
  }

  async function run(append) {
    if (busy) return;
    busy = true;
    const params = queryParams(current);
    if (append && cursor) params.set("cursor", cursor);
    if (!append) {
      list.classList.add("loading");
      statusEl.textContent = current.q ? "検索中…" : "読み込み中…";
    }

    try {
      const d = await (await fetch("/api/search?" + params)).json();
      const why = WHY[d.error];
      if (why) {
        list.textContent = "";
        statusEl.textContent = why;
        moreBtn.hidden = true;
        return;
      }
      if (d.error) throw new Error(d.message || d.error);
      const rows = d.results.map(render);
      if (append) list.append(...rows);
      else list.replaceChildren(...rows);   // 届いてから一度に入れ替える
      cursor = d.next;
      moreBtn.hidden = !cursor;
      const shown = list.children.length;
      if (!shown) {
        await explainEmpty(current);
      } else {
        const cond = condText(current);
        statusEl.textContent = (cond ? cond + " ／ " : "") +
          `${fmt(shown)} 件表示${cursor ? "（まだあります）" : ""}`;
      }
      if (blogNote) {
        statusEl.append("　※ブログの指定は、1人だけ選んでいるときに使えます");
        blogNote = false;
      }
    } catch (e) {
      if (!append) list.textContent = "";
      statusEl.textContent = "読み込めませんでした: " + e.message;
      moreBtn.hidden = true;
    } finally {
      list.classList.remove("loading");
      busy = false;
    }
  }

  /* ---------------- 日付で見る ---------------- */

  const level = (n, max) => (n ? Math.min(4, Math.ceil((n / max) * 4)) : 0);
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymNo = (s) => +s.slice(0, 4) * 12 + (+s.slice(5, 7) - 1);   // "YYYY-MM" → 月の番号
  const ymStr = (n) => `${Math.floor(n / 12)}-${pad2(n % 12 + 1)}`;
  const lastDay = (y, m) => new Date(y, m, 0).getDate();
  let view = "";     // カレンダーに出している月 "YYYY-MM"
  let calNo = 0;     // 後から出した条件の結果を優先する

  // いつから・いつまでで絞った範囲(月の番号)。月や日を押して選んだ期間(d)では、表とカレンダーは絞らない
  function span() {
    if (!current.from && !current.to) return null;
    const f = current.from, t = current.to;
    return {
      lo: f ? ymNo(f.length === 4 ? f + "-01" : f) : -Infinity,
      hi: t ? ymNo(t.length === 4 ? t + "-12" : t) : Infinity,
    };
  }
  // 表とカレンダーに出す、投稿のある月(いつから・いつまでの範囲の中だけ)
  function shownYms() {
    if (!cal) return [];
    const r = span();
    return [...cal.months.keys()].filter((k) => !r || (ymNo(k) >= r.lo && ymNo(k) <= r.hi));
  }

  // メンバーを選んでいるときに出す(誰も選んでいないときの全員分の集計は重い)。
  // 年×月の表は1人のときだけ(何人も混ぜた月ごとの数は見ても使いどころがない)。日のカレンダーは何人でも出す。
  // keepView: カレンダーの ‹ › で月を動かしたとき(出す月を期間から決め直さない)
  async function loadCalendar(keepView) {
    const my = ++calNo;
    if (!picked.size) { calEl.hidden = true; cal = null; syncDates(); return; }
    // 検索語があれば、カレンダーの数字は「その語を含む記事の数」になる
    const base = `/api/calendar?m=${current.m}&b=${encodeURIComponent(current.b)}` +
      (current.q ? `&q=${encodeURIComponent(current.q)}` : "");
    const key = `${current.m}@${current.b}@${current.q}`;
    if (!cal || cal.key !== key) {
      const r = await (await fetch(base)).json();
      if (my !== calNo) return;
      cal = { key, months: new Map(r.months), ym: "", days: new Map() };
    }
    // 出す月: 押して選んだ月・日 > いつから > いま出している月。投稿のある範囲の中に収める
    let v = view;
    if (!keepView) {
      if (current.d.length >= 7) v = current.d.slice(0, 7);
      else if (current.from) v = current.from.length === 4 ? current.from + "-01" : current.from;
    }
    const list = shownYms();
    if (list.length) {
      const n = v ? ymNo(v) : Infinity;
      v = ymStr(Math.min(Math.max(n, ymNo(list[0])), ymNo(list[list.length - 1])));
    }
    view = v;
    if (view && cal.ym !== view) {
      const r = await (await fetch(`${base}&ym=${view}`)).json();
      if (my !== calNo) return;
      cal.days = new Map(r.days);
      cal.ym = view;
    }
    syncDates();
    drawYears();
    drawMonth();
    calEl.hidden = cal.months.size === 0;
  }

  // 年が左・月が上の表。押すとその月だけになり、もう一度押すと外れる
  function drawYears() {
    yearsEl.textContent = "";
    const yms = shownYms();
    yearsEl.hidden = picked.size !== 1 || !yms.length;
    if (yearsEl.hidden) return;
    const max = Math.max(...yms.map((k) => cal.months.get(k)));
    const y0 = +yms[0].slice(0, 4), y1 = +yms[yms.length - 1].slice(0, 4);
    yearsEl.append(el("span"));
    for (let m = 1; m <= 12; m++) yearsEl.append(el("span", { class: "mh" }, String(m)));
    for (let y = y1; y >= y0; y--) {   // 新しい年を上に
      yearsEl.append(el("span", { class: "yl" }, String(y)));
      for (let m = 1; m <= 12; m++) {
        const ym = `${y}-${pad2(m)}`;
        const n = yms.includes(ym) ? cal.months.get(ym) : 0;
        yearsEl.append(el("button", {
          type: "button",
          class: `l${level(n, max)}` + (current.d.startsWith(ym) ? " on" : "") + (ym === view ? " cur" : ""),
          title: `${y}年${m}月 ${fmt(n)}件`,
          "aria-label": `${y}年${m}月 ${fmt(n)}件`,
          disabled: !n,
          onclick: () => pick(ym),
        }, n ? String(n) : ""));
      }
    }
  }

  // 日のカレンダー。‹ › は投稿がある月へ移るだけ(絞り込みは変えない)。日を押すとその日だけになる
  function drawMonth() {
    monthEl.textContent = "";
    if (!view) return;
    const [y, m] = view.split("-").map(Number);
    const yms = shownYms();
    const cur = ymNo(view);
    const prev = [...yms].reverse().find((k) => ymNo(k) < cur) || null;
    const next = yms.find((k) => ymNo(k) > cur) || null;
    const go = (to) => { view = to; loadCalendar(true).catch(() => {}); };

    monthEl.append(el("div", { class: "month-nav" },
      el("button", { type: "button", disabled: !prev, onclick: () => go(prev), "aria-label": "前の投稿がある月" }, "‹"),
      el("strong", {}, `${y}年${m}月（${fmt(cal.months.get(view))}件）`),
      el("button", { type: "button", disabled: !next, onclick: () => go(next), "aria-label": "次の投稿がある月" }, "›")));

    const grid = el("div", { class: "days" });
    ["日", "月", "火", "水", "木", "金", "土"].forEach((w) => grid.append(el("span", { class: "wd" }, w)));
    const first = new Date(y, m - 1, 1).getDay();
    for (let k = 0; k < first; k++) grid.append(el("span"));
    const last = lastDay(y, m);
    const max = Math.max(1, ...cal.days.values());
    for (let dd = 1; dd <= last; dd++) {
      const day = `${view}-${pad2(dd)}`;
      const n = cal.days.get(day) || 0;
      grid.append(el("button", {
        type: "button",
        class: `l${level(n, max)}` + (current.d === day ? " on" : ""),
        disabled: !n && current.d !== day,
        "aria-label": `${m}月${dd}日 ${n}件`,
        onclick: () => pick(day),
      }, String(dd), n ? el("small", {}, "/" + n, el("span", { class: "u" }, "件")) : null));   // 日付の横に件数
    }
    monthEl.append(grid);
  }

  // 月か日を押す(選択中のものをもう一度押したら外す)。いつから・いつまでの指定はこれに置き換わる
  function pick(d) {
    if (!d) return;
    current.d = current.d === d ? "" : d;
    current.from = current.to = "";
    search(true, true);
  }

  /* ---------------- いつから・いつまで(年・月を選ぶ) ---------------- */
  // 日はカレンダーで選ぶので、ここは年と月だけ。年だけでも選べる(いつからはその年の初め、いつまではその年の終わり)。
  // メンバーを選んでいるときは、投稿のある年・月だけ選べる。選んでいないときは、全部の年・月から選べる(いつも出しておく)
  const FIRST_YEAR = 2007;   // このサイトに記事のある、いちばん古い年
  const boxOf = (id) => document.querySelector(`.dsel[data-for="${id}"]`);
  function opt(sel, value, text) { sel.append(el("option", { value }, text)); }
  function syncDates() {
    const all = cal ? [...cal.months.keys()] : [];
    let years = [...new Set(all.map((k) => k.slice(0, 4)))];
    years.reverse();   // 新しい年を上に
    // メンバーを選んでいないとき(月ごとの数を持っていないとき)は、アメブロが始まった年から今年までを出す
    if (!cal) { years = []; for (let y = new Date().getFullYear(); y >= FIRST_YEAR; y--) years.push(String(y)); }
    for (const id of ["from", "to"]) {
      // 月・日を押して選んだ期間(d)は、いつから・いつまでの両方にその年・月を出す
      const v = current.d ? current.d.slice(0, 7) : current[id];
      const vy = v.slice(0, 4), vm = v.length >= 7 ? String(+v.slice(5, 7)) : "";
      const box = boxOf(id), y = box.querySelector(".y"), m = box.querySelector(".m");
      y.textContent = "";
      opt(y, "", "年");
      const ys = years.includes(vy) || !vy ? years : [...years, vy].sort().reverse();
      for (const k of ys) opt(y, k, `${k}年`);
      m.textContent = "";
      opt(m, "", "月");
      let ms = cal ? all.filter((k) => k.slice(0, 4) === vy).map((k) => String(+k.slice(5, 7)))
        : (vy ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] : []);
      if (vm && !ms.includes(vm)) ms = [...ms, vm].sort((a, b) => a - b);
      for (const k of ms) opt(m, k, `${k}月`);
      m.disabled = !vy;
      y.value = vy;
      m.value = vm;
    }
  }
  function dateChanged(id, changedYear) {
    const val = (k) => {
      const box = boxOf(k), y = box.querySelector(".y").value;
      let m = box.querySelector(".m").value;
      // 年を変えて、その年に投稿のない月になったら、月は外す
      if (k === id && changedYear && m && cal && !cal.months.has(`${y}-${pad2(+m)}`)) m = "";
      return y ? y + (m ? "-" + pad2(+m) : "") : "";
    };
    current.from = val("from");
    current.to = val("to");
    current.d = "";
    search(true, true);
  }
  for (const id of ["from", "to"]) {
    boxOf(id).querySelector(".y").addEventListener("change", () => dateChanged(id, true));
    boxOf(id).querySelector(".m").addEventListener("change", () => dateChanged(id, false));
  }

  /* ---------------- メンバー選択 ---------------- */

  function drawChips() {
    chipsEl.textContent = "";
    for (const m of [...picked].map(memberOf).filter(Boolean)) {
      chipsEl.append(el("span", { class: "chip" }, m.name,
        el("button", { type: "button", "aria-label": `${m.name}を外す`, onclick: () => toggleMember(m.no) }, "×")));
    }
    // 1人だけ選んでいて、その人がブログを複数持つならブログ別に絞れるようにする
    const s = solo();
    // ブログだけで絞っている(誰も選んでいない)
    if (!picked.size && blogPick && allBlogs.some((b) => b.id === blogPick)) {
      chipsEl.append(el("span", { class: "chip" }, `ブログ: ${blogName(blogPick)}`,
        el("button", { type: "button", "aria-label": "ブログの指定を外す", onclick: () => pickBlog("") }, "×")));
      chipsEl.hidden = false;
      pickLabel.textContent = "メンバー選択　ブログで絞り込み中";
      return;
    }
    // URL などで来たブログがその人のものでなければ外す(検索は全ブログになるので、URL からも消す)
    if (blogPick && !(s && s.blogs.some((b) => b.id === blogPick))) {
      if (picked.size > 1) blogNote = true;
      blogPick = "";
    }
    if (s && s.blogs.length > 1) {
      const sel = el("select", {
        "aria-label": "ブログ",
        onchange: (e) => { blogPick = e.target.value; queueSearch(true); },
      }, el("option", { value: "" }, "すべてのブログ"));
      for (const b of s.blogs) sel.append(el("option", { value: b.id }, b.title));
      sel.value = blogPick;
      chipsEl.append(sel);
    } else {
      blogPick = "";
    }
    chipsEl.hidden = !chipsEl.children.length;
    pickLabel.textContent = picked.size ? `メンバー選択　現在${picked.size}人` : "メンバー選択";
  }

  // グループのタグは「一覧をそのグループに絞って見せる」切り替え。押しても誰も選ばれない。
  // 数字は「選んでいる人数/その中の人数」
  function groupTag(label, mem, on, onclick) {
    const n = mem.filter((m) => picked.has(m.no)).length;
    return el("button", { type: "button", class: "tag" + (on ? " on" : ""), "aria-pressed": on, onclick },
      label, el("span", { class: "n" }, n ? `${n}/${mem.length}` : String(mem.length)));
  }

  const GROUP_BUTTONS = ["モーニング娘。", "アンジュルム", "Juice=Juice", "つばきファクトリー", "BEYOOOOONDS",
    "OCHA NORMA", "ロージークロニクル", "J.P ROOM", "UP-FRONT CREATE", "UP-FRONT PROMOTION"];

  function drawPanel() {
    const q = msearch.value.trim();
    glist.textContent = "";
    glist.append(groupTag("すべて", pool(), gView === null, () => setView(null)));
    const groups = allGroups.filter((g) => inGroup(g).length);   // 現役のみだと誰も残らないグループは出さない
    if (gView !== null && !groups.some((g) => g.no === gView)) gView = null;
    // ボタンはインスタ検索と同じグループだけ(カントリー娘。・メロン記念日・Berryz工房・℃-ute・カントリー・ガールズの人は「ブログで絞る」から選べる)
    for (const name of GROUP_BUTTONS) {
      const g = groups.find((x) => x.name === name);
      if (g) glist.append(groupTag(g.name, inGroup(g), gView === g.no, () => setView(g.no)));
    }

    mlist.textContent = "";
    const base = gView === null ? pool() : inGroup({ no: gView });
    const shown = base.filter((m) => !q || m.name.includes(q) || (m.kana || "").includes(q));
    // 読み仮名が無い人は末尾に回す(並べようがないので)
    if (byKana) shown.sort((a, b) => (a.kana || "んん").localeCompare(b.kana || "んん", "ja"));
    for (const m of shown) {
      // 検索エンジンがメンバー別ページ(/?m=番号)をたどれるようリンクにする。押したときは読み直さず選ぶだけ
      mlist.append(el("a", {
        href: `/?m=${m.no}`,
        role: "button",
        class: "tag" + (picked.has(m.no) ? " on" : ""),
        "aria-pressed": picked.has(m.no),
        onclick: (ev) => { ev.preventDefault(); toggleMember(m.no); },
      }, m.name));
    }
    if (!shown.length) mlist.append(el("span", { class: "none" }, "該当なし"));
    mcount.textContent = `${fmt(shown.length)}人`;

    // ブログ(プルダウン): 何人かで書くブログを先に、そのあと1人のブログを書き手の読み順で。
    // グループを見ているときは、そのグループの人が書いているブログだけ
    const inView = gView === null ? null : new Set(inGroup({ no: gView }).map((m) => m.no));
    const blogs = allBlogs.map((b) => ({ ...b, w: writersOf(b.id), name: blogName(b.id) }))
      .filter((b) => b.w.length && (!inView || b.w.some((m) => inView.has(m.no))) &&
        (!q || b.name.includes(q) || b.w.some((m) => m.name.includes(q) || (m.kana || "").includes(q))));
    blogs.sort((a, b) => (b.w.length > 1) - (a.w.length > 1) ||
      (a.w.length > 1 ? a.name.localeCompare(b.name, "ja") : (a.w[0].kana || "んん").localeCompare(b.w[0].kana || "んん", "ja")));
    const bsel = $("bsel"), cur = !picked.size ? blogPick : "";
    bsel.textContent = "";
    bsel.append(el("option", { value: "" }, cur ? "ブログの指定を外す" : "ブログで絞る"));
    // 選んでいるブログは、グループを変えて一覧から外れても、選択肢に残す
    if (cur && !blogs.some((b) => b.id === cur) && allBlogs.some((b) => b.id === cur)) bsel.append(el("option", { value: cur }, blogName(cur)));
    for (const b of blogs) bsel.append(el("option", { value: b.id }, b.name));
    bsel.value = cur;
    bsel.classList.toggle("on", !!cur);
    // 選べるブログが1つ以下なら、絞る意味がないので出さない
    bsel.parentElement.hidden = blogs.length <= 1;

    // グループに絞っている時だけ、見えている人をまとめて選べる
    const allBtn = $("pick-all");
    const all = shown.length && shown.every((m) => picked.has(m.no));
    allBtn.hidden = gView === null || !shown.length;
    allBtn.textContent = all ? "全員外す" : "全員選ぶ";
    allBtn.onclick = () => {
      for (const m of shown) if (all) picked.delete(m.no); else picked.add(m.no);
      drawChips();
      drawPanel();
      queueSearch();
    };
  }

  $("bsel").addEventListener("change", (e) => {
    const id = e.target.value;
    if (id) pickBlog(id);
    else if (blogPick) pickBlog(blogPick);   // 「ブログの指定を外す」
  });

  function setView(no) {
    gView = no;
    drawPanel();
  }

  // ブログだけで絞る。選ぶとメンバーの指定は外れる。同じものをもう一度押すと外す
  function pickBlog(id) {
    picked.clear();
    blogPick = blogPick === id ? "" : id;
    drawChips();
    drawPanel();
    queueSearch();
  }

  function toggleMember(no) {
    if (!picked.size) blogPick = "";   // ブログだけの指定からメンバー指定に切り替える
    if (picked.has(no)) picked.delete(no); else picked.add(no);
    drawChips();
    drawPanel();
    queueSearch();
  }

  // 連打しても最後の1回だけ検索する
  function queueSearch() {
    clearTimeout(hold);
    hold = setTimeout(() => search(true, false), 250);
  }

  /* ---------------- 条件の反映 ---------------- */

  // keepPeriod: 期間(d・いつから・いつまで)を引き継ぐか。メンバーを変えた時は外す
  function search(pushHistory, keepPeriod) {
    const bad = tooMuch(qEl.value.trim());
    if (bad) {
      list.textContent = "";
      moreBtn.hidden = true;
      statusEl.textContent = WHY[bad];
      return;
    }
    current = {
      q: qEl.value.trim(),
      m: [...picked].join(","),
      b: picked.size <= 1 ? blogPick : "",
      act: actEl.checked,
      d: (keepPeriod && current ? current.d : "") || "",
      from: (keepPeriod && current ? current.from : "") || "",
      to: (keepPeriod && current ? current.to : "") || "",
      order: orderEl.value,
    };
    cursor = null;

    const u = new URL(location.href);
    u.search = shareParams(current).toString();
    // 開いたとき・戻ったときも、使えない指定(その人に無いブログなど)を落とした URL に置き換える
    if (pushHistory) history.pushState(null, "", u);
    else if (u.href !== location.href) history.replaceState(null, "", u);
    // 1人だけ選んでいてタイトルが作れないときは、今のタイトル(Worker が書いたもの)を残す
    const mt = memberTitle(current);
    if (current.q) document.title = `${current.q} - ハロプロ アメブロ検索`;
    else if (mt) document.title = mt;
    else if (!(current.m && !current.m.includes(","))) document.title = "ハロプロ アメブロ検索";

    loadCalendar().catch(() => { calEl.hidden = true; });
    run(false);
  }

  function fromUrl() {
    const p = new URLSearchParams(location.search);
    qEl.value = p.get("q") || "";
    orderEl.value = p.get("order") || "";
    actEl.checked = p.has("act") ? p.get("act") === "1" : true;
    picked.clear();
    for (const s of (p.get("m") || "").split(",")) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) picked.add(n);
    }
    blogPick = p.get("b") || "";
    drawChips();
    drawPanel();
    const d = p.get("d") || "";
    const ymOk = (v) => (/^\d{4}(-\d{2})?$/.test(v || "") ? v : "");
    current = { d: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d) ? d : "", from: ymOk(p.get("from")), to: ymOk(p.get("to")) };
    search(false, true);
  }

  // 検索したらメンバー選択のパネルは畳む(結果を見せるため)
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    panel.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    search(true, true);
  });
  // 検索語を消しきったら、その場で検索語なしの表示(選んでいるメンバーの新着)に戻す
  qEl.addEventListener("input", () => {
    if (!qEl.value.trim() && current && current.q) search(true, true);
  });
  orderEl.addEventListener("change", () => search(true, true));
  actEl.addEventListener("change", () => {
    // 現役のみに戻したら、卒業生の選択は外す
    if (actEl.checked) for (const no of [...picked]) if (!memberOf(no)?.active) picked.delete(no);
    drawChips();
    drawPanel();
    search(true, false);
  });
  msearch.addEventListener("input", drawPanel);
  $("pick-sort").addEventListener("click", (e) => {
    byKana = !byKana;
    e.currentTarget.textContent = byKana ? "グループ順" : "あいうえお順";
    e.currentTarget.setAttribute("aria-pressed", String(byKana));
    drawPanel();
  });
  openBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    openBtn.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) msearch.focus();
  });
  $("pick-close").addEventListener("click", () => {
    panel.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
  });
  // リセット: メンバー・ブログ・検索語・期間・並び・現役のみを最初の状態に戻す
  $("reset").addEventListener("click", () => {
    picked.clear();
    blogPick = "";
    gView = null;
    qEl.value = "";
    msearch.value = "";
    orderEl.value = "";
    actEl.checked = true;
    drawChips();
    drawPanel();
    search(true, false);
  });
  // 日付をリセット: いつから・いつまで・押した月や日だけを外す(メンバーや検索語はそのまま)
  $("reset-date").addEventListener("click", () => {
    current.d = current.from = current.to = "";
    search(true, true);
  });
  $("pick-clear").addEventListener("click", () => {
    picked.clear();
    blogPick = "";
    drawChips();
    drawPanel();
    queueSearch();
  });
  // 続きが無いのに押されたら何もしない(cursor 無しで読むと先頭のページを足してしまう)
  moreBtn.addEventListener("click", () => { if (cursor) run(true); });
  window.addEventListener("popstate", fromUrl);


  // 選んだメンバーのブログに site: で絞って Google を開く。何人かで書くブログで1人を選んでいたら名前も足す
  // (記事タイトルに名前が入るので、その人の記事に寄る)。誰も選んでいなければ開かない
  const G_MAX = 8;   // site: を OR でつなぐ数の上限(Google は32語まで)
  // 選んでいる期間(押して選んだ月・日、またはいつから・いつまで)を、Google の after: / before: にする。
  // after: はその年・月・日の初め、before: は終わりの次の日(その日は含まない)
  function googlePeriod() {
    const c = current || {};
    const lo = c.d || c.from, hi = c.d || c.to;
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const out = [];
    if (lo) out.push("after:" + day(Date.UTC(+lo.slice(0, 4), lo.length >= 7 ? +lo.slice(5, 7) - 1 : 0, lo.length >= 10 ? +lo.slice(8, 10) : 1)));
    if (hi) {
      const y = +hi.slice(0, 4);
      out.push("before:" + day(hi.length >= 10 ? Date.UTC(y, +hi.slice(5, 7) - 1, +hi.slice(8, 10) + 1)
        : hi.length >= 7 ? Date.UTC(y, +hi.slice(5, 7), 1) : Date.UTC(y + 1, 0, 1)));
    }
    return out.join(" ");
  }
  function google() {
    const note = $("g-note");
    const ms = [...picked].map(memberOf).filter(Boolean);
    let ids = blogPick ? [blogPick] : [...new Set(ms.flatMap((m) => m.blogs.map((b) => b.id)))];
    if (!ids.length) { note.textContent = "メンバーかブログを選んでください"; return; }
    if (ids.length > G_MAX) { note.textContent = `ブログが多すぎます（${G_MAX}個まで。いま${ids.length}個）`; return; }
    note.textContent = "";
    const site = ids.map((id) => `site:ameblo.jp/${id}`).join(" OR ");
    const name = ms.length === 1 && ids.some((id) => writersOf(id).length > 1) ? ms[0].name : "";
    // 検索語を先に、site: と期間はそのあと
    const q = [qEl.value.trim(), name, ids.length > 1 ? `(${site})` : site, googlePeriod()].filter(Boolean).join(" ");
    window.open("https://www.google.com/search?" + new URLSearchParams({ q }), "_blank", "noopener");
  }
  $("g-web").addEventListener("click", google);

  fetch("/api/members").then((r) => r.json()).then((d) => {
    allMembers = d.members || [];
    allGroups = d.groups || [];
    allBlogs = d.blogs || [];
    const s = d.stats || {};
    if (s.ingested) {
      $("stats").textContent = `収録 ${fmt(s.ingested)} 記事 / ${fmt(s.blogs)} ブログ` +
        (s.total > s.ingested ? `（全 ${fmt(s.total)} 記事を取り込み中）` : "");
    }
  }).catch(() => {}).then(() => siteReady).finally(fromUrl);
})();
