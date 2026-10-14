(() => {
  const $ = (id) => document.getElementById(id);
  const dateEl = $("date"), gnav = $("gnav"), statusEl = $("status"), list = $("results");

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

  // 日付は日本時間で扱う(published が +09:00 の文字列なので)
  const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const shift = (d, n) => {
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const label = (d) => {
    const [y, m, dd] = d.split("-").map(Number);
    const w = "日月火水木金土"[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    return `${y}年${m}月${dd}日（${w}）`;
  };

  const NONE = "none";   // 書き手が決まっていない記事(スタッフ投稿など)
  let groups = [], groupsOf = new Map();   // member_no → [group_no]
  let day = "", rows = [], pick = "";      // pick: "" = すべて / group_no / NONE
  let seq = 0;

  const inPick = (r) => {
    if (!pick) return true;
    if (pick === NONE) return r.member_no == null;
    return (groupsOf.get(r.member_no) || []).includes(Number(pick));
  };

  function drawNav() {
    gnav.textContent = "";
    const count = new Map();
    let none = 0;
    for (const r of rows) {
      if (r.member_no == null) { none++; continue; }
      for (const g of groupsOf.get(r.member_no) || []) count.set(g, (count.get(g) || 0) + 1);
    }
    const item = (key, name, n) => el("button", {
      type: "button", class: "gitem" + (pick === key ? " on" : ""), "aria-pressed": pick === key ? "true" : "false",
      onclick: () => { pick = pick === key && key ? "" : key; sync(); draw(); },
    }, el("span", { class: "gname" }, name), el("span", { class: "n" }, String(n)));

    gnav.append(item("", "すべて", rows.length));
    // その日に記事があるグループだけ、グループ番号順に出す
    for (const g of groups) if (count.get(g.no)) gnav.append(item(String(g.no), g.name, count.get(g.no)));
    if (none) gnav.append(item(NONE, "書き手不明", none));
  }

  function drawList() {
    list.textContent = "";
    const shown = rows.filter(inPick);
    for (const r of shown) {
      const meta = el("p", { class: "meta" },
        el("time", {}, r.time),
        el("span", { class: "who" }, r.member || r.blog_title),
        r.blog_title !== r.member ? el("a", { href: r.blog_url, target: "_blank", rel: "noopener" }, r.blog_title) : null,
        r.theme_url ? el("a", { href: r.theme_url, target: "_blank", rel: "noopener" }, `テーマ: ${r.theme}`) : null);
      list.append(el("li", {},
        el("h2", {}, el("a", { href: r.url, target: "_blank", rel: "noopener" }, r.title)),
        meta));
    }
    const name = !pick ? "" : pick === NONE ? "書き手不明・" : `${(groups.find((g) => String(g.no) === pick) || {}).name}・`;
    statusEl.textContent = rows.length
      ? `${label(day)}　${name}${shown.length} 件`
      : `${label(day)}　この日の記事はありません`;
  }

  const draw = () => { drawNav(); drawList(); };

  // URL に日付とグループを残す(共有・戻る用)。今日・すべては書かない
  function sync(push) {
    const p = new URLSearchParams();
    if (day !== jstToday()) p.set("d", day);
    if (pick) p.set("g", pick);
    const u = location.pathname + (p.toString() ? "?" + p : "");
    if (push) history.pushState(null, "", u); else history.replaceState(null, "", u);
  }

  async function load(d, push) {
    day = d;
    dateEl.value = d;
    $("next").disabled = d >= jstToday();
    sync(push);
    const my = ++seq;
    statusEl.textContent = `${label(d)}　読み込み中…`;
    list.classList.add("loading");
    try {
      const r = await (await fetch(`/api/day?d=${d}`)).json();
      if (my !== seq) return;   // 連打したときは最後の日付だけ描く
      rows = r.results || [];
      draw();
      if (r.truncated) statusEl.textContent += "（多すぎるため一部だけ表示しています）";
    } catch {
      if (my === seq) statusEl.textContent = "読み込めませんでした。時間をおいて開き直してください";
    } finally {
      if (my === seq) list.classList.remove("loading");
    }
  }

  function fromUrl() {
    const p = new URLSearchParams(location.search);
    const d = p.get("d");
    pick = p.get("g") || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : jstToday();
  }

  dateEl.max = jstToday();
  dateEl.addEventListener("change", () => { if (dateEl.value) load(dateEl.value, true); });
  $("prev").addEventListener("click", () => load(shift(day, -1), true));
  $("next").addEventListener("click", () => load(shift(day, 1), true));
  $("today").addEventListener("click", () => load(jstToday(), true));
  $("dayform").addEventListener("submit", (e) => e.preventDefault());
  addEventListener("popstate", () => load(fromUrl(), false));

  // グループ情報(メンバー→所属グループ)を先に読んでから一覧を出す
  fetch("/api/members").then((r) => r.json()).then((d) => {
    groups = (d.groups || []).map((g) => ({ no: g.no ?? g.group_no, name: g.name }));
    for (const m of d.members || []) groupsOf.set(m.no, m.groups || []);
  }).catch(() => {}).finally(() => load(fromUrl(), false));
})();
