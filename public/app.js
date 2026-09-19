(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("f"), qEl = $("q"), mEl = $("m"), orderEl = $("order");
  const statusEl = $("status"), list = $("results"), moreBtn = $("more");
  const calEl = $("cal"), yearsEl = $("years"), monthEl = $("month");
  const periodEl = $("period"), periodT = $("period-t");

  let current = null;   // 表示中の検索条件 {q, m, b, d, order}
  let cursor = null;
  let busy = false;
  let cal = null;       // 日付で見る: {key, months: Map(ym→件数), ym, days: Map(日→件数)}

  const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");

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

  /* ---------------- 検索結果 ---------------- */

  function render(r) {
    const meta = el("p", { class: "meta" },
      el("span", { class: "who" }, r.member || r.blog_title),
      el("time", {}, r.date),
      r.member && r.blog_title !== r.member ? el("span", {}, r.blog_title) : null);

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
    if (!r.snippets.length) li.append(el("p", { class: "locked" }, "本文なし（画像・埋め込みのみ）"));
    return li;
  }

  function queryParams(c) {
    const p = new URLSearchParams();
    for (const k of ["q", "m", "b", "d", "order"]) if (c[k]) p.set(k, c[k]);
    return p;
  }

  async function run(append) {
    if (busy) return;
    busy = true;
    moreBtn.hidden = true;
    const params = queryParams(current);
    if (append && cursor) params.set("cursor", cursor);
    if (!append) { list.textContent = ""; statusEl.textContent = "検索中…"; }

    try {
      const d = await (await fetch("/api/search?" + params)).json();
      if (d.error === "short") {
        statusEl.textContent = "検索語が短すぎます（ひらがな・カタカナは2文字以上）";
        return;
      }
      if (d.error) throw new Error(d.message || d.error);
      for (const r of d.results) list.append(render(r));
      cursor = d.next;
      moreBtn.hidden = !cursor;
      const shown = list.children.length;
      statusEl.textContent = shown ? `${fmt(shown)} 件表示${cursor ? "（まだあります）" : ""}` : "見つかりませんでした";
    } catch (e) {
      statusEl.textContent = "検索できませんでした: " + e.message;
    } finally {
      busy = false;
    }
  }

  /* ---------------- 日付で見る ---------------- */

  const level = (n, max) => (n ? Math.min(4, Math.ceil((n / max) * 4)) : 0);

  async function loadCalendar() {
    if (!current.m) { calEl.hidden = true; cal = null; return; }
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

  /* ---------------- 条件の反映 ---------------- */

  // keepPeriod: 期間(d)を引き継ぐか。メンバーを変えた時は外す
  function search(pushHistory, keepPeriod) {
    // メンバーの選択肢は「番号」か「番号@ブログID」(ブログが複数ある人のブログ別)
    const [m, b] = mEl.value.split("@");
    const d = keepPeriod && current ? current.d : "";
    current = { q: qEl.value.trim(), m: m || "", b: b || "", d: d || "", order: orderEl.value };
    cursor = null;

    const u = new URL(location.href);
    u.search = queryParams(current).toString();
    if (pushHistory) history.pushState(null, "", u);
    document.title = current.q ? `${current.q} - アメブロ検索` : "アメブロ検索";

    periodEl.hidden = !current.d;
    periodT.textContent = current.d ? `期間: ${periodLabel(current.d)}` : "";

    loadCalendar().catch(() => { calEl.hidden = true; });
    if (!current.q && !current.m && !current.d) {
      list.textContent = "";
      statusEl.textContent = "";
      moreBtn.hidden = true;
      return;
    }
    run(false);
  }

  function fromUrl() {
    const p = new URLSearchParams(location.search);
    qEl.value = p.get("q") || "";
    const m = p.get("m") || "", b = p.get("b") || "";
    mEl.value = b ? `${m}@${b}` : m;
    if (mEl.value !== (b ? `${m}@${b}` : m)) mEl.value = m;
    orderEl.value = p.get("order") || "";
    const d = p.get("d") || "";
    current = { d: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d) ? d : "" };
    search(false, true);
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); search(true, true); });
  mEl.addEventListener("change", () => search(true, false));
  orderEl.addEventListener("change", () => search(true, true));
  moreBtn.addEventListener("click", () => run(true));
  $("period-x").addEventListener("click", () => { current.d = ""; search(true, true); });
  window.addEventListener("popstate", fromUrl);

  fetch("/api/members").then((r) => r.json()).then((d) => {
    for (const m of d.members) {
      if (m.blogs.length < 2) {
        mEl.append(el("option", { value: String(m.no) }, m.name));
        continue;
      }
      // ブログが複数ある人は、全部まとめて＋ブログごと
      const g = el("optgroup", { label: m.name });
      g.append(el("option", { value: String(m.no) }, `${m.name}（すべて）`));
      for (const b of m.blogs) g.append(el("option", { value: `${m.no}@${b.id}` }, `${m.name}（${b.title}）`));
      mEl.append(g);
    }
    const s = d.stats || {};
    if (s.ingested) {
      $("stats").textContent = `収録 ${fmt(s.ingested)} 記事 / ${fmt(s.blogs)} ブログ` +
        (s.total > s.ingested ? `（全 ${fmt(s.total)} 記事を取り込み中）` : "");
    }
  }).catch(() => {}).finally(fromUrl);
})();
