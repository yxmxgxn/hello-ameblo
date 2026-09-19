(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("f"), qEl = $("q"), mEl = $("m"), orderEl = $("order");
  const statusEl = $("status"), list = $("results"), moreBtn = $("more");

  let current = null;   // 表示中の検索条件
  let cursor = null;
  let busy = false;

  const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === "class") e.className = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }

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
    if (!r.snippets.length) {
      li.append(el("p", { class: "locked" }, r.restricted ? "アメンバー限定記事" : "本文なし（画像・埋め込みのみ）"));
    }
    return li;
  }

  async function run(append) {
    if (busy) return;
    busy = true;
    moreBtn.hidden = true;
    const params = new URLSearchParams();
    if (current.q) params.set("q", current.q);
    if (current.m) params.set("m", current.m);
    if (current.b) params.set("b", current.b);
    if (current.order) params.set("order", current.order);
    if (append && cursor) params.set("cursor", cursor);
    if (!append) { list.textContent = ""; statusEl.textContent = "検索中…"; }

    try {
      const res = await fetch("/api/search?" + params);
      const d = await res.json();
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

  function search(pushHistory) {
    // メンバーの選択肢は「番号」か「番号@ブログID」(ブログが複数ある人のブログ別)
    const [m, b] = mEl.value.split("@");
    current = { q: qEl.value.trim(), m: m || "", b: b || "", order: orderEl.value };
    cursor = null;
    const u = new URL(location.href);
    u.search = "";
    if (current.q) u.searchParams.set("q", current.q);
    if (current.m) u.searchParams.set("m", current.m);
    if (current.b) u.searchParams.set("b", current.b);
    if (current.order) u.searchParams.set("order", current.order);
    if (pushHistory) history.pushState(null, "", u);
    document.title = current.q ? `${current.q} - アメブロ検索` : "アメブロ検索";
    if (!current.q && !current.m) {
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
    search(false);
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); search(true); });
  mEl.addEventListener("change", () => search(true));
  orderEl.addEventListener("change", () => search(true));
  moreBtn.addEventListener("click", () => run(true));
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
