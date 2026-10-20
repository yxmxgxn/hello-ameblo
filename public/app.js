(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("f"), qEl = $("q"), actEl = $("act"), orderEl = $("order");
  const statusEl = $("status"), list = $("results"), moreBtn = $("more");
  const calEl = $("cal"), yearsEl = $("years"), monthEl = $("month");
  const periodEl = $("period"), periodT = $("period-t");
  const panel = $("panel"), openBtn = $("pick-open"), pickLabel = $("pick-label");
  const glist = $("glist"), mlist = $("mlist"), chipsEl = $("chips");
  const msearch = $("msearch"), mcount = $("mcount");

  let current = null;       // 表示中の条件 {q, m, b, act, d, order}
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
  // サーバー(src/worker.js の MAX_Q / MAX_TERMS)と同じ上限
  const MAX_Q = 100, MAX_TERMS = 5;
  const WHY = {
    short: "検索語が短すぎます（ひらがな・カタカナ・英数字は2文字以上。漢字は1文字から）",
    long: `検索語が長すぎます（${MAX_Q}文字まで）`,
    many: `区切った語が多すぎます（${MAX_TERMS}語まで）`,
    empty: "検索に使える文字がありません（記号・絵文字は検索に使えません）",
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

  // ブログの表示名。1人だけのブログは「名前（ブログ名）」、何人かで書くブログはブログ名だけ
  const writersOf = (id) => allMembers.filter((m) => m.blogs.some((b) => b.id === id));
  function blogName(id) {
    const b = allBlogs.find((x) => x.id === id);
    const w = writersOf(id);
    const title = b ? b.title : id;
    return w.length === 1 ? `${w[0].name}（${title}）` : title;
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
    return parts.join(" ／ ");
  }
  // 検索語以外の絞り込みがあるか(0件のとき、絞り込みのせいかを確かめるため)
  const narrowed = (c) => !!(c.m || c.b || c.d || c.act);
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
          current = { ...current, d: "" };
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
      el("span", { class: "who" }, r.member || r.blog_title),
      el("time", {}, r.date),
      // ブログのトップと、その人のテーマ(グループブログの中の個人ページ)へ飛べるようにする
      r.blog_title !== r.member
        ? el("a", { href: r.blog_url, target: "_blank", rel: "noopener noreferrer" }, r.blog_title)
        : null,
      r.theme_url ? el("a", { href: r.theme_url, target: "_blank", rel: "noopener noreferrer" }, `テーマ: ${r.theme}`) : null);

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
        statusEl.textContent = (cond ? cond + " ／ " : current.q ? "" : "新着 ") +
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

  // カレンダーは1人だけ選んでいる時に出す(全員分の集計は重いし、見ても使いどころがない)
  async function loadCalendar() {
    $("cal-hint").hidden = picked.size === 1;
    if (picked.size !== 1) { calEl.hidden = true; cal = null; return; }
    // 検索語があれば、カレンダーの数字は「その語を含む記事の数」になる
    const base = `/api/calendar?m=${current.m}&b=${encodeURIComponent(current.b)}` +
      (current.q ? `&q=${encodeURIComponent(current.q)}` : "");
    const key = `${current.m}@${current.b}@${current.q}`;
    const ym = current.d.length >= 7 ? current.d.slice(0, 7) : "";
    if (!cal || cal.key !== key) {
      const r = await (await fetch(base)).json();
      cal = { key, months: new Map(r.months), ym: "", days: new Map() };
    }
    if (ym && cal.ym !== ym) {
      const r = await (await fetch(`${base}&ym=${ym}`)).json();
      cal.days = new Map(r.days);
    }
    cal.ym = ym;
    $("cal-note").textContent = current.q ? `濃いほど「${current.q}」が多い月` : "濃いほど投稿が多い月";
    drawYears();
    drawMonth();
    calEl.hidden = cal.months.size === 0;
  }

  function drawYears() {
    yearsEl.textContent = "";
    const yms = [...cal.months.keys()];
    if (!yms.length) return;
    const max = Math.max(...cal.months.values());
    const y0 = +yms[0].slice(0, 4), y1 = +yms[yms.length - 1].slice(0, 4);
    yearsEl.append(el("span"));
    for (let m = 1; m <= 12; m++) yearsEl.append(el("span", { class: "mh" }, String(m)));
    for (let y = y1; y >= y0; y--) {   // 新しい年を上に
      yearsEl.append(el("span", { class: "yl" }, String(y)));
      for (let m = 1; m <= 12; m++) {
        const ym = `${y}-${String(m).padStart(2, "0")}`;
        const n = cal.months.get(ym) || 0;
        yearsEl.append(el("button", {
          type: "button",
          class: `l${level(n, max)}` + (current.d.startsWith(ym) ? " on" : ""),
          title: `${y}年${m}月 ${fmt(n)}件`,
          "aria-label": `${y}年${m}月 ${fmt(n)}件`,
          disabled: !n,
          onclick: () => pick(ym),
        }, n ? String(n) : ""));
      }
    }
  }

  function drawMonth() {
    monthEl.textContent = "";
    monthEl.hidden = !cal.ym;
    if (!cal.ym) return;
    const [y, m] = cal.ym.split("-").map(Number);
    const yms = [...cal.months.keys()];
    const i = yms.indexOf(cal.ym);
    const prev = i > 0 ? yms[i - 1] : null;               // 投稿のある月だけ辿る
    const next = i >= 0 && i < yms.length - 1 ? yms[i + 1] : null;

    monthEl.append(el("div", { class: "month-nav" },
      el("button", { type: "button", disabled: !prev, onclick: () => pick(prev), "aria-label": "前の投稿がある月" }, "‹"),
      el("strong", {}, `${y}年${m}月（${fmt(cal.months.get(cal.ym))}件）`),
      el("button", { type: "button", disabled: !next, onclick: () => pick(next), "aria-label": "次の投稿がある月" }, "›")));

    const grid = el("div", { class: "days" });
    ["日", "月", "火", "水", "木", "金", "土"].forEach((w) => grid.append(el("span", { class: "wd" }, w)));
    const first = new Date(y, m - 1, 1).getDay();
    for (let k = 0; k < first; k++) grid.append(el("span"));
    const last = new Date(y, m, 0).getDate();
    const max = Math.max(1, ...cal.days.values());
    for (let dd = 1; dd <= last; dd++) {
      const day = `${cal.ym}-${String(dd).padStart(2, "0")}`;
      const n = cal.days.get(day) || 0;
      grid.append(el("button", {
        type: "button",
        class: `l${level(n, max)}` + (current.d === day ? " on" : ""),
        disabled: !n,
        "aria-label": `${m}月${dd}日 ${n}件`,
        onclick: () => pick(day),
      }, String(dd), n ? el("small", {}, `${n}件`) : null));
    }
    monthEl.append(grid);
  }

  // 月か日を選ぶ(選択中の日をもう一度押したら月に戻す、選択中の月なら外す)
  function pick(d) {
    if (!d) return;
    if (current.d === d) d = d.length === 10 ? d.slice(0, 7) : "";
    current.d = d;
    search(true, true);
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

  function drawPanel() {
    const q = msearch.value.trim();
    glist.textContent = "";
    glist.append(groupTag("すべて", pool(), gView === null, () => setView(null)));
    const groups = allGroups.filter((g) => inGroup(g).length);   // 現役のみだと誰も残らないグループは出さない
    if (gView !== null && !groups.some((g) => g.no === gView)) gView = null;
    for (const g of groups) glist.append(groupTag(g.name, inGroup(g), gView === g.no, () => setView(g.no)));

    mlist.textContent = "";
    const base = gView === null ? pool() : inGroup({ no: gView });
    const shown = base.filter((m) => !q || m.name.includes(q) || (m.kana || "").includes(q));
    // 読み仮名が無い人は末尾に回す(並べようがないので)
    if (byKana) shown.sort((a, b) => (a.kana || "んん").localeCompare(b.kana || "んん", "ja"));
    for (const m of shown) {
      mlist.append(el("button", {
        type: "button",
        class: "tag" + (picked.has(m.no) ? " on" : ""),
        "aria-pressed": picked.has(m.no),
        onclick: () => toggleMember(m.no),
      }, m.name));
    }
    if (!shown.length) mlist.append(el("span", { class: "none" }, "該当なし"));
    mcount.textContent = `${fmt(shown.length)}人`;

    // ブログ: 何人かで書くブログを先に、そのあと1人のブログを書き手の読み順で
    const blist = $("blist");
    blist.textContent = "";
    const blogs = allBlogs.map((b) => ({ ...b, w: writersOf(b.id), name: blogName(b.id) }))
      .filter((b) => b.w.length && (!q || b.name.includes(q) || b.w.some((m) => m.name.includes(q) || (m.kana || "").includes(q))));
    blogs.sort((a, b) => (b.w.length > 1) - (a.w.length > 1) ||
      (a.w.length > 1 ? a.name.localeCompare(b.name, "ja") : (a.w[0].kana || "んん").localeCompare(b.w[0].kana || "んん", "ja")));
    for (const b of blogs) {
      const on = !picked.size && blogPick === b.id;
      blist.append(el("button", {
        type: "button", class: "tag" + (on ? " on" : ""), "aria-pressed": on, onclick: () => pickBlog(b.id),
      }, b.name));
    }
    if (!blogs.length) blist.append(el("span", { class: "none" }, "該当なし"));
    // ブログだけで絞っている時と、名前で探している時は開いておく。それ以外は畳んでおく
    if (!picked.size && blogPick || q) $("bsec").open = true;

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

  // keepPeriod: 期間(d)を引き継ぐか。メンバーを変えた時は外す
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
      order: orderEl.value,
    };
    cursor = null;

    const u = new URL(location.href);
    u.search = shareParams(current).toString();
    // 開いたとき・戻ったときも、使えない指定(その人に無いブログなど)を落とした URL に置き換える
    if (pushHistory) history.pushState(null, "", u);
    else if (u.href !== location.href) history.replaceState(null, "", u);
    document.title = current.q ? `${current.q} - アメブロ検索` : "アメブロ検索";

    periodEl.hidden = !current.d;
    periodT.textContent = current.d ? `期間: ${periodLabel(current.d)}` : "";

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
    current = { d: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d) ? d : "" };
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
  $("pick-clear").addEventListener("click", () => {
    picked.clear();
    blogPick = "";
    drawChips();
    drawPanel();
    queueSearch();
  });
  // 続きが無いのに押されたら何もしない(cursor 無しで読むと先頭のページを足してしまう)
  moreBtn.addEventListener("click", () => { if (cursor) run(true); });
  $("period-x").addEventListener("click", () => { current.d = ""; search(true, true); });
  window.addEventListener("popstate", fromUrl);


  fetch("/api/members").then((r) => r.json()).then((d) => {
    allMembers = d.members || [];
    allGroups = d.groups || [];
    allBlogs = d.blogs || [];
    const s = d.stats || {};
    if (s.ingested) {
      $("stats").textContent = `収録 ${fmt(s.ingested)} 記事 / ${fmt(s.blogs)} ブログ` +
        (s.total > s.ingested ? `（全 ${fmt(s.total)} 記事を取り込み中）` : "");
    }
  }).catch(() => {}).finally(fromUrl);
})();
