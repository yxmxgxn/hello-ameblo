# アメブロ検索の D1 コマンドの書き方

別のチャットで、このサイト（ハロプロ アメブロ検索）の D1 に対するコマンド（SQL）を書いてもらうときの前提メモです。
このファイルごと貼ってください。

## 1. 基本

- データベース名: `hello-ameblo`（D1 = SQLite。Cloudflare の APAC リージョン）
- Worker 側のバインディング名: `DB`
- 本番に対して実行する書き方（`--remote` が必須。付けないと手元のローカル DB に対して動き、本番は変わらない）

```bash
# 1文を実行
npx wrangler d1 execute hello-ameblo --remote --command "SELECT count(*) FROM entries"

# ファイルを実行（複数文）
npx wrangler d1 execute hello-ameblo --remote --file fix.sql

# 結果をJSONで
npx wrangler d1 execute hello-ameblo --remote --json --command "..."
```

- ダッシュボードで実行する場合: Cloudflare → ストレージとデータベース → D1 → hello-ameblo → コンソール
- 1文ずつ、`;` で終える。複数文はファイルにするか、コンソールに順に貼る。
- **更新系（UPDATE / DELETE / INSERT）は、先に同じ条件の `SELECT count(*)` で件数を確かめてから実行する。** D1 に元に戻す操作はない（必要なら先に `SELECT` した結果を保存しておく）。

## 2. テーブル

### entries（記事。約36万行）
| 列 | 内容 |
|---|---|
| `entry_id` | 主キー。アメブロの記事番号（時系列で増える） |
| `blog` | ブログID（例 `juicejuice-official`） |
| `theme_id` / `theme_name` | グループブログの中のテーマ（個人ブログは空） |
| `member_no` | 書き手のメンバー番号。決まっていない記事は `NULL` |
| `title` / `body` | タイトル / 本文（本文はここにだけ持つ） |
| `published` | 公開日時。**日本時間の文字列** `2016-03-05T21:00:00.000+09:00`。月・日は前方一致や `substr(published,1,7)` で引く |
| `edited` | アメブロの last_edit_datetime（変わると本文を取り直す） |
| `restricted` | 1=アメンバー限定などで本文が取れなかった |
| `gone_since` | 「消えたかも」と判定した時刻。`NULL` なら生きている |
| `publish_flg` / `ins_datetime` / `upd_datetime` / `fetched_at` | 記録用 |

索引: `(blog, theme_id)` `(member_no, entry_id)` `(blog, entry_id)` `(member_no, published)` `(published)` `(blog, published)` `gone_since`（あるものだけの部分索引）。
新しい順に並べる・件数を数えるなら、これらの索引に乗る条件で書くと軽い（全記事を舐めない）。

### members / member_meta / groups
- `members(member_no PK, name, kana)`
- `member_meta(member_no PK, groups, active)` … `groups` は **`,11,12,` の形（前後にもカンマ）**。引くときは `groups LIKE '%,11,%'`。`active` は 1=ハロプロ現役
- `groups(group_no PK, name)` … 2 モーニング娘。/ 5 カントリー娘。/ 6 メロン記念日 / 7 Berryz工房 / 9 ℃-ute / 11 アンジュルム / 12 Juice=Juice / 13 カントリー・ガールズ / 15 つばきファクトリー / 16 BEYOOOOONDS / 17 OCHA NORMA / 18 ロージークロニクル / 101 J.P ROOM / 102 UP-FRONT CREATE / 103 UP-FRONT PROMOTION

### targets / blogs / member_blogs / checks
- `targets(blog, theme_id, member_no)` … どのブログ（・テーマ）が誰のものか。`theme_id=''` はブログ丸ごとその人。**スプシ（SNSスプシ）から巡回のたびに作り直すので、手で変えても戻る。** 例外はリポジトリの `crawler/fixes.tsv` に書く
- `blogs(blog PK, title, total, newest_id, cursor_page, done, ingested, updated_at)` … 巡回の進み具合
- `member_blogs(member_no, blog, n)` … 記事があるブログ。巡回のたびに作り直す
- `checks(blog PK, page, prev_min, cycles, updated_at)` … 削除チェックの進み具合
- `state(k PK, v)` … 1回きりの覚え書き
- `takedown(...)` … 削除・公開停止の依頼（`done` 1=対応済み）

### entry_fts（全文検索）
- FTS5 の contentless 表（`rowid = entry_id`）。中身は正規化した **2文字区切り（bigram）の文字列**で、`title` と `body` の列に入る
- **`entries` の `title` / `body` を SQL で直接書き換えても、`entry_fts` は更新されない。** 検索に出る内容が食い違うので、本文やタイトルを直接 UPDATE するのは避ける（直すなら取り込み直し）
- **記事を直接 DELETE するときは、`entry_fts` からも消す。** `DELETE FROM entry_fts WHERE rowid IN (...)` を併せて実行する（残ると検索に出ない幽霊行になる）
- ふつうは削除を SQL で行わず、後述の「削除（手動）」の方法を使う

## 3. よく使う SELECT

```sql
-- ブログごとの記事数
SELECT blog, count(*) FROM entries GROUP BY blog ORDER BY 2 DESC;

-- 書き手が決まっていない記事（ブログ別）
SELECT blog, theme_name, count(*) AS n
FROM entries WHERE member_no IS NULL
GROUP BY blog, theme_name ORDER BY n DESC;

-- あるメンバーの月別の件数
SELECT substr(published,1,7) AS ym, count(*) FROM entries
WHERE member_no = 3 GROUP BY ym ORDER BY ym;

-- 確認待ち（消えたかも）の記事
SELECT entry_id, blog, title, gone_since FROM entries
WHERE gone_since IS NOT NULL ORDER BY gone_since;

-- 名前からメンバー番号
SELECT member_no, name FROM members WHERE name LIKE '%石黒%';

-- 現役のグループ12(Juice=Juice)のメンバー
SELECT mb.member_no, mb.name FROM members mb
JOIN member_meta mm ON mm.member_no = mb.member_no
WHERE mm.active = 1 AND mm.groups LIKE '%,12,%';

-- 巡回の進み具合
SELECT blog, ingested, total, done, updated_at FROM blogs ORDER BY updated_at DESC LIMIT 20;
```

## 4. 更新の例（実行前に必ず件数を確認）

```sql
-- 1つの記事の書き手を決める（fixes.tsv の entry 行と同じ意味）
UPDATE entries SET member_no = 98 WHERE entry_id = 12345678901;

-- 確認待ちの印を外す
UPDATE entries SET gone_since = NULL WHERE entry_id = 12345678901;
```

- **書き手の割り当ては、SQL で直接変えるより `crawler/fixes.tsv` に書くのが本来のやり方**（巡回のたびに `fixes.tsv` が適用されるため、SQL で変えても、あとで上書きされることがある）。
  - `entry <記事番号> <メンバー番号>`（`-` で取り込まない）
  - `theme <ブログ>/<テーマ番号> <メンバー番号>`
- `title` 書き換えの規則など、割り当てが関わる変更は `fixes.tsv` 側で行う。

## 5. 削除（手動）

- **巡回は記事を自動で消さない。** 消えたと判定された記事には `gone_since` の印が付き、Discord に知らせが来る。消すかどうかは人が決める。
- 手動で消すときは、クローラ用 API の `delete_ids`（Actions の手動実行の入力）を使う。SQL で `DELETE` する場合は、上の `entry_fts` も併せて消すこと。

## 6. 注意

- **本番の D1 に直接つながる。** 更新系を書くときは、対象の絞り込みを必ず確かめる（`WHERE` 抜けの `UPDATE` / `DELETE` が一番危ない）。
- **画面には反映が遅れる。** API の結果は、毎時20分まで（クロール後）キャッシュされる（カレンダー・メンバー一覧は最長5分）。SQL を実行してもすぐには画面に出ないことがある。
- **スキーマの変更は `schema.sql` に書く。** デプロイのたびに `schema.sql`（`IF NOT EXISTS`）が適用されるので、`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` の形で書く。列の追加は `ALTER TABLE ... ADD COLUMN` を1回だけ実行し、`schema.sql` の `CREATE TABLE` にも同じ列を書き足す。
- 大きなテーブル（`entries` 約36万行）で、条件に索引が乗らない `SELECT` / `UPDATE` は、読み取り行数が増えて重い。`published`・`member_no`・`blog`・`entry_id` を使った絞り込みを優先する。
- 書き込みの上限（1回の `execute` の文の大きさ・件数）に当たったら、`entry_id` の範囲で分けて実行する。
- 個人情報: `takedown` の `contact` / `message` は、依頼してきた人の入力。外に出さない。

## 7. 依頼するときの書き方（別チャットで）

「このメモの前提で、次の SQL を書いてください」と添えて、次のどれかを伝えてください。

- 何を知りたいか（SELECT）／何を変えたいか（UPDATE・DELETE）
- 対象（メンバー名・ブログID・記事番号・期間）
- 変える場合は、実行前に確かめる `SELECT count(*)` も一緒に出してほしい、ということ
