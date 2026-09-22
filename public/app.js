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
  let allMembers = [], allGroups = [];
  const picked = new Set(); // 選択中のメンバー番号。グループを押すとまとめて入る
  let blogPick = "";        // 1人だけ選んだ時の、その人のブログ別指定
  let byKana = false;       // メンバーの並び: false=グループ順(既定) / true=あいうえお順
  let hold = null;          // 選ぶたびに叩かないよう少し待つ

  const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
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
        ? el("a", { href: r.blog_url, target: "_blank", rel: "noopener" }, r.blog_title)
        : null,
      r.theme_url ? el("a", { href: r.theme_url, target: "_blank", rel: "noopener" }, `テーマ: ${r.theme}`) : null);

    const li = el("li", {},
      el("h2", {}, el("a", { href: r.url, target: "_blank", rel: "noopener" }, r.title)),
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
      list.textContent = "";
      statusEl.textContent = current.q ? "検索中…" : "読み込み中…";
    }

    try {
      const d = await (await fetch("/api/search?" + params)).json();
      const why = {
        short: "検索語が短すぎます（ひらがな・カタカナ・英数字は2文字以上。漢字は1文字から）",
        long: `検索語が長すぎます（${d.max}文字まで）`,
        empty: "検索に使える文字がありません（記号・絵文字は検索に使えません）",
      }[d.error];
      if (why) {
        statusEl.textContent = why;
        moreBtn.hidden = true;
        return;
      }
      if (d.error) throw new Error(d.message || d.error);
      for (const r of d.results) list.append(render(r));
      cursor = d.next;
      moreBtn.hidden = !cursor;
      const shown = list.children.length;
      if (!shown) statusEl.textContent = current.q ? "見つかりませんでした" : "記事がありません";
      else statusEl.textContent = (current.q ? "" : "新着 ") + `${fmt(shown)} 件表示${cursor ? "（まだあります）" : ""}`;
    } catch (e) {
      statusEl.textContent = "読み込めませんでした: " + e.message;
      moreBtn.hidden = true;
    } finally {
      busy = false;
    }
  }

  /* ---------------- 日付で見る ---------------- */

  const level = (n, max) => (n ? Math.min(4, Math.ceil((n / max) * 4)) : 0);

  // カレンダーは1人だけ選んでいる時に出す(全員分の集計は重いし、見ても使いどころがない)
  async function loadCalendar() {
    if (picked.size !== 1) { calEl.hidden = true; cal = null; return; }
    const base = `/api/calendar?m=${current.m}&b=${encodeURIComponent(current.b)}`;
    const key = `${current.m}@${current.b}`;
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

  function drawPanel() {
    const q = msearch.value.trim();
    glist.textContent = "";
    for (const g of allGroups) {
      const mem = inGroup(g);
      if (!mem.length) continue;             // 現役のみだと誰も残らないグループは出さない
      const on = mem.filter((m) => picked.has(m.no)).length;
      glist.append(el("button", {
        type: "button",
        class: "tag" + (on === mem.length ? " on" : on ? " part" : ""),
        "aria-pressed": on === mem.length,
        onclick: () => toggleGroup(g),
      }, g.name, el("span", { class: "n" }, String(mem.length))));
    }

    mlist.textContent = "";
    const shown = pool().filter((m) => !q || m.name.includes(q) || (m.kana || "").includes(q));
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
  }

  function toggleMember(no) {
    if (picked.has(no)) picked.delete(no); else picked.add(no);
    drawChips();
    drawPanel();
    queueSearch();
  }

  // グループを押すと、その中の(現役のみの指定に合う)全員が入る。全員入っていれば全員外す
  function toggleGroup(g) {
    const mem = inGroup(g);
    const all = mem.every((m) => picked.has(m.no));
    for (const m of mem) if (all) picked.delete(m.no); else picked.add(m.no);
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
    current = {
      q: qEl.value.trim(),
      m: [...picked].join(","),
      b: picked.size === 1 ? blogPick : "",
      act: actEl.checked,
      d: (keepPeriod && current ? current.d : "") || "",
      order: orderEl.value,
    };
    cursor = null;

    const u = new URL(location.href);
    u.search = shareParams(current).toString();
    if (pushHistory) history.pushState(null, "", u);
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

  form.addEventListener("submit", (e) => { e.preventDefault(); search(true, true); });
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
    drawChips();
    drawPanel();
    queueSearch();
  });
  moreBtn.addEventListener("click", () => run(true));
  $("period-x").addEventListener("click", () => { current.d = ""; search(true, true); });
  window.addEventListener("popstate", fromUrl);


  fetch("/api/members").then((r) => r.json()).then((d) => {
    allMembers = d.members || [];
    allGroups = d.groups || [];
    const s = d.stats || {};
    if (s.ingested) {
      $("stats").textContent = `収録 ${fmt(s.ingested)} 記事 / ${fmt(s.blogs)} ブログ` +
        (s.total > s.ingested ? `（全 ${fmt(s.total)} 記事を取り込み中）` : "");
    }
  }).catch(() => {}).finally(fromUrl);
})();
