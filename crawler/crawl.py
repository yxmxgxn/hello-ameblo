"""アメブロを巡回して記事本文を検索用D1に取り込むクローラ。

対象ブログとメンバーの対応は karin-archive の SNSスプシ(accounts)から読む:
  platform=ameblo   → ブログ丸ごとその人      (ID列=ブログID)
  platform=ameblo_g → グループブログのテーマ    (ID列=ブログID, MEMBER列=テーマ番号)

1回の実行でやること:
  1. スプシの対応表を Worker に送る(紐づけが変わった記事はWorker側で付け直す)
  2. 新着: 各ブログの entrylist を1ページ目から読み、取り込み済みの最新IDより新しい記事を取る
  3. 遡り: 過去記事が残っているブログを1ページ(20件)ずつ順番に遡る。予算(件数/時間)が尽きたら終了
     次回は続きから(進み具合は D1 の blogs テーブルに持つので、実行環境は状態を持たない)

アメブロのページには window.INIT_DATA に JSON が埋まっていて、
  entrylist(-N).html : 20件ずつの記事一覧(タイトル・日時・テーマ。本文は無い)
  entry-ID.html      : その記事の本文(entry_text, HTML)
が取れる。本文は記事ページを1件ずつ読むしかない。

使い方:
  python crawler/crawl.py --api https://<worker>/ --token $CRAWL_TOKEN
  python crawler/crawl.py --api http://localhost:8787 --token dev --blogs angerme-new --max-fetch 60
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

ACCOUNTS_CSV = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vSLHCVWWxyVI5GS9SSohSNYL4U-uY4jekuMXbaKYXYjWrSZlgSxGV0BFvnCWRrd-A4Z5sqkoRwRyDqD/pub"
    "?gid=1522035537&single=true&output=csv"
)
UA = "Mozilla/5.0 (compatible; hello-ameblo-crawler/0.1)"
PER_PAGE = 20
POST_BATCH = 20

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a)


# ============================ アメブロ ============================

class Ameblo:
    def __init__(self, delay: float):
        self.delay = delay
        self.fetches = 0
        self._last = 0.0

    def get(self, url: str, tries: int = 3) -> str | None:
        for n in range(tries):
            wait = self._last + self.delay - time.time()
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            self.fetches += 1
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                if e.code in (404, 410):
                    return None
                log("  ! HTTP", e.code, url)
            except Exception as e:  # noqa: BLE001 タイムアウト等は数回やり直す
                log("  !", type(e).__name__, url)
            time.sleep(5 * (n + 1))
        return None

    @staticmethod
    def init_data(page: str | None) -> dict | None:
        if not page:
            return None
        m = "window.INIT_DATA="
        i = page.find(m)
        if i < 0:
            return None
        i += len(m)
        j = page.find(";window.", i)
        try:
            return json.loads(page[i:j])
        except ValueError:
            return None

    def entry_list(self, blog: str, page: int):
        """(記事の一覧[新しい順], paging, ブログ名) を返す。取れなければ None。"""
        suf = "" if page == 1 else f"-{page}"
        d = self.init_data(self.get(f"https://ameblo.jp/{blog}/entrylist{suf}.html"))
        if not d:
            return None
        es = d.get("entryState", {})
        emap = es.get("entryMap", {})
        paging, order = {}, []
        for v in es.get("blogPageMap", {}).values():
            paging = v.get("paging") or {}
            order = v.get("data") or []
        entries = [emap[str(i)] for i in order if str(i) in emap] or list(emap.values())
        entries.sort(key=lambda e: int(e["entry_id"]), reverse=True)
        title = ""
        for b in d.get("bloggerState", {}).get("bloggerMap", {}).values():
            title = (b.get("official") or {}).get("upper_text") or (b.get("profile") or {}).get("nickname") or title
        return entries, paging, title

    def entry_body(self, blog: str, entry_id) -> str | None:
        d = self.init_data(self.get(f"https://ameblo.jp/{blog}/entry-{entry_id}.html"))
        if not d:
            return None
        e = d.get("entryState", {}).get("entryMap", {}).get(str(entry_id)) or {}
        return e.get("entry_text") or ""


# 本文として扱わない埋め込み。ページ上は見えていても本人の文章ではなく、検索のノイズになる
#   ogpCard_*      : URLを貼ると出るリンクカード(リンク先のタイトル・説明文)
#   twitter-tweet  : Xポストの埋め込み(公式の告知の引用など)
#   instagram-media: Instagramの埋め込み
SKIP_CLASSES = {"ogpCard_root", "ogpCard_wrap", "twitter-tweet", "instagram-media"}
SKIP_TAGS = {"script", "style", "noscript", "iframe", "svg"}
BLOCK_TAGS = {"br", "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote", "article"}
VOID_TAGS = {"br", "img", "hr", "input", "meta", "link", "wbr", "source", "embed", "col", "area", "param", "track"}


class _BodyText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0  # 除外中の要素の入れ子の深さ

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            if not self.skip and tag == "br":
                self.out.append("\n")
            return
        if self.skip:
            self.skip += 1
            return
        cls = set((dict(attrs).get("class") or "").split())
        if tag in SKIP_TAGS or cls & SKIP_CLASSES:
            self.skip = 1
            return
        if tag in BLOCK_TAGS:
            self.out.append("\n")

    def handle_startendtag(self, tag, attrs):
        if not self.skip and tag == "br":
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if self.skip:
            self.skip -= 1
            return
        if tag in BLOCK_TAGS:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(s: str) -> str:
    p = _BodyText()
    p.feed(s or "")
    p.close()
    text = "".join(p.out).replace("\u00a0", " ")
    lines = [re.sub(r"[ \t\u3000]+", " ", ln).strip() for ln in text.split("\n")]
    out, blank = [], False
    for ln in lines:
        if ln:
            out.append(ln)
            blank = False
        elif not blank and out:
            out.append("")
            blank = True
    return "\n".join(out).strip()


# ============================ Worker API ============================

class DbLimit(Exception):
    """D1 の上限(無料枠の容量・1日の書き込み数)に当たった。"""


class Api:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                     "User-Agent": UA},
        )
        for n in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                msg = e.read().decode("utf-8", "replace")[:300]
                if e.code == 507:
                    raise DbLimit(msg) from None
                if e.code < 500:
                    raise RuntimeError(f"{method} {path} -> {e.code} {msg}") from None
                log("  ! api", e.code, path, msg)
            except urllib.error.URLError as e:
                log("  ! api", e.reason, path)
            time.sleep(3 * (n + 1))
        raise RuntimeError(f"{method} {path} failed")


# ============================ 対象の読み込み ============================

def load_targets(src: str):
    if re.match(r"https?://", src):
        with urllib.request.urlopen(urllib.request.Request(src, headers={"User-Agent": UA}), timeout=60) as r:
            text = r.read().decode("utf-8-sig")
    else:
        with open(src, encoding="utf-8-sig") as f:
            text = f.read()
    rows = list(csv.reader(io.StringIO(text)))[1:]
    members, targets = {}, {}
    for r in rows:
        r = (r + [""] * 5)[:5]
        no, name, platform, bid, theme = (x.strip() for x in r)
        if platform not in ("ameblo", "ameblo_g") or not bid or not no.isdigit():
            continue
        # ID列に theme-xxx.html 付きで入っている場合も拾う
        m = re.match(r"(?:https?://ameblo\.jp/)?([\w-]+)(?:/theme-(\d+)\.html)?", bid)
        if not m:
            continue
        blog = m.group(1)
        theme = theme if platform == "ameblo_g" else ""
        theme = theme or (m.group(2) or "")
        if platform == "ameblo_g" and not theme:
            continue  # テーマ不明のグループブログ行は誰の記事か決められないので紐づけない
        members[int(no)] = name
        targets[(blog, theme)] = int(no)
    return (
        [{"member_no": k, "name": v} for k, v in sorted(members.items())],
        [{"blog": b, "theme_id": t, "member_no": n} for (b, t), n in sorted(targets.items())],
    )


# ============================ 巡回 ============================

class Crawler:
    def __init__(self, api: Api, ab: Ameblo, max_fetch: int, deadline: float):
        self.api = api
        self.ab = ab
        self.max_fetch = max_fetch
        self.deadline = deadline
        self.inserted = 0

    def budget_left(self) -> bool:
        return self.ab.fetches < self.max_fetch and time.time() < self.deadline

    def ingest(self, blog: str, metas: list[dict]) -> bool:
        """一覧の記事(メタ情報)の本文を取って送る。途中で予算切れなら False。"""
        ids = [str(e["entry_id"]) for e in metas]
        known = set(self.api.call("POST", "/api/crawl/known", {"ids": ids})["known"]) if ids else set()
        todo = [e for e in metas if str(e["entry_id"]) not in known]
        batch = []
        for e in todo:
            if not self.budget_left():
                self.flush(batch)
                return False
            raw = self.ab.entry_body(blog, e["entry_id"])
            body = html_to_text(raw or "")
            batch.append({
                "entry_id": str(e["entry_id"]),
                "blog": blog,
                "theme_id": str(e.get("theme_id") or ""),
                "theme_name": e.get("theme_name") or "",
                "title": e.get("entry_title") or "",
                "published": e.get("entry_created_datetime") or "",
                "body": body,
                "restricted": not body,  # アメンバー限定・削除済みなど
            })
            if len(batch) >= POST_BATCH:
                self.flush(batch)
                batch = []
        self.flush(batch)
        return True

    def flush(self, batch: list[dict]):
        if not batch:
            return
        r = self.api.call("POST", "/api/crawl/entries", {"entries": batch})
        self.inserted += r.get("inserted", 0)

    def update_new(self, blog: str, st: dict):
        """新着分。newest_id より新しい記事を1ページ目から拾う。"""
        newest = int(st.get("newest_id") or 0)
        page, top, fresh, title, total = 1, None, [], None, None
        while self.budget_left():
            got = self.ab.entry_list(blog, page)
            if got is None:
                log(f"  {blog}: 一覧が取れない(削除/非公開?)")
                return
            entries, paging, title = got
            total = paging.get("total_count", total)
            if not entries:
                break
            if top is None:
                top = int(entries[0]["entry_id"])
            new = [e for e in entries if int(e["entry_id"]) > newest]
            fresh += new
            if not newest or len(new) < len(entries) or page >= int(paging.get("max_page") or 1):
                break  # 初回は1ページ目だけ(残りは遡りで拾う)
            page += 1
        if fresh:
            log(f"  {blog}: 新着 {len(fresh)} 件")
        if self.ingest(blog, list(reversed(fresh))) and top:
            self.api.call("POST", "/api/crawl/blog", {
                "blog": blog, "title": title, "total": total, "newest_id": max(top, newest),
                "cursor_page": None if newest else 2,
            })

    def backfill_page(self, blog: str, st: dict) -> bool:
        """過去記事を1ページ分遡る。まだ続きがあれば True。"""
        page = int(st.get("cursor_page") or 1)
        got = self.ab.entry_list(blog, page)
        if got is None:
            return False
        entries, paging, _ = got
        max_page = int(paging.get("max_page") or 0)
        if not entries or page > max_page:
            self.api.call("POST", "/api/crawl/blog", {"blog": blog, "done": True})
            log(f"  {blog}: 最古まで遡り終えた")
            return False
        if not self.ingest(blog, entries):
            return False  # 予算切れ。同じページを次回やり直す(取り込み済みは known で飛ばす)
        st["cursor_page"] = page + 1
        done = page + 1 > max_page
        self.api.call("POST", "/api/crawl/blog", {
            "blog": blog, "cursor_page": page + 1, "done": done, "total": paging.get("total_count"),
        })
        if done:
            log(f"  {blog}: 最古まで遡り終えた")
        return not done


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default=os.environ.get("CRAWL_API"), help="WorkerのURL")
    ap.add_argument("--token", default=os.environ.get("CRAWL_TOKEN"))
    ap.add_argument("--accounts", default=ACCOUNTS_CSV, help="SNSスプシ(accounts)のCSV URLかパス")
    ap.add_argument("--blogs", help="このブログだけ巡回(カンマ区切り。試験用)")
    ap.add_argument("--max-fetch", type=int, default=3000, help="アメブロへのリクエスト上限")
    ap.add_argument("--minutes", type=float, default=50, help="実行時間の上限(分)")
    ap.add_argument("--delay", type=float, default=1.0, help="アメブロへのリクエスト間隔(秒)")
    ap.add_argument("--no-backfill", action="store_true", help="新着だけ見る")
    a = ap.parse_args()
    if not a.api or not a.token:
        ap.error("--api と --token (または CRAWL_API / CRAWL_TOKEN) が必要")

    api = Api(a.api, a.token)
    ab = Ameblo(a.delay)
    cr = Crawler(api, ab, a.max_fetch, time.time() + a.minutes * 60)

    members, targets = load_targets(a.accounts)
    only = set(a.blogs.split(",")) if a.blogs else None
    r = api.call("POST", "/api/crawl/targets", {"members": members, "targets": targets})
    log(f"対象: メンバー{r['members']}人 / 紐づけ{r['targets']}件 (付け直し {r['remapped']})")

    blogs = sorted({t["blog"] for t in targets})
    if only:
        blogs = [b for b in blogs if b in only]
    state = {b["blog"]: b for b in api.call("GET", "/api/crawl/state")["blogs"]}

    try:
        log(f"新着チェック: {len(blogs)} ブログ")
        for b in blogs:
            if not cr.budget_left():
                break
            cr.update_new(b, state.setdefault(b, {"blog": b}))

        if not a.no_backfill:
            state = {b["blog"]: b for b in api.call("GET", "/api/crawl/state")["blogs"]}
            pending = [b for b in blogs if b in state and not state[b].get("done")]
            log(f"遡り: 残り {len(pending)} ブログ")
            while pending and cr.budget_left():
                nxt = []
                for b in pending:  # 1ページずつ順番に。全員が少しずつ埋まっていく
                    if not cr.budget_left():
                        nxt.append(b)
                        break
                    if cr.backfill_page(b, state[b]):
                        nxt.append(b)
                pending = nxt
    except DbLimit as e:
        # 無料枠の上限。失敗扱いにせず終わる(Paidにするか翌日になれば次の実行で続きから)
        log(f"D1の上限に当たったので今回はここまで: {e}")

    log(f"終了: 取得 {ab.fetches} 回 / 新規取り込み {cr.inserted} 件")


if __name__ == "__main__":
    main()
