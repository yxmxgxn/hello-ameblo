-- アメブロ検索 D1 スキーマ
-- 適用: wrangler d1 execute hello-ameblo --remote --file schema.sql
--
-- 本文はここ(D1)にだけ持つ。サイトには全文を出さず、検索結果の前後数十字だけ返して
-- 元記事(ameblo.jp)へ飛ばす。

-- メンバー名。番号はSNSスプシ(accounts)の1列目と同じ。
CREATE TABLE IF NOT EXISTS members (
  member_no INTEGER PRIMARY KEY,
  name      TEXT NOT NULL
);

-- どのブログ(・テーマ)が誰のものか。SNSスプシの ameblo / ameblo_g 行から毎回作り直す。
-- theme_id='' は「ブログ丸ごとその人」(個人ブログ)。
CREATE TABLE IF NOT EXISTS targets (
  blog      TEXT NOT NULL,
  theme_id  TEXT NOT NULL DEFAULT '',
  member_no INTEGER,
  PRIMARY KEY (blog, theme_id)
);

-- クロールの進み具合(ブログ単位)。
-- newest_id  : 取り込み済みの最新記事ID。新着チェックはこれより新しいものだけ拾う
-- cursor_page: 過去記事を遡る時に次に読む entrylist のページ番号
-- done       : 最古まで遡り終えたら 1
CREATE TABLE IF NOT EXISTS blogs (
  blog        TEXT PRIMARY KEY,
  title       TEXT,
  total       INTEGER,
  newest_id   INTEGER,
  cursor_page INTEGER NOT NULL DEFAULT 1,
  done        INTEGER NOT NULL DEFAULT 0,
  ingested    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT
);

-- 記事。entry_id はアメブロの記事番号(時系列で増える)をそのまま主キーに使う。
-- member_no は targets から決める。テーマが誰にも紐づかない記事(スタッフ投稿など)は NULL。
CREATE TABLE IF NOT EXISTS entries (
  entry_id   INTEGER PRIMARY KEY,
  blog       TEXT NOT NULL,
  theme_id   TEXT,
  theme_name TEXT,
  member_no  INTEGER,
  title      TEXT,
  published  TEXT,
  body       TEXT,
  edited     TEXT,                        -- アメブロの last_edit_datetime。変わっていたら本文を取り直す
  restricted INTEGER NOT NULL DEFAULT 0,   -- アメンバー限定など本文が取れなかった記事
  edited     TEXT,                        -- アメブロの last_edit_datetime。変わっていたら本文を取り直す
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS entries_blog_theme ON entries(blog, theme_id);
CREATE INDEX IF NOT EXISTS entries_member ON entries(member_no, entry_id);

-- 全文検索。rowid = entry_id。中身は「宮本 本佳 佳林 …」の空白区切りbigram。
-- contentless(content='')なので bigram 文字列そのものは保存せず索引だけ持つ(容量節約)。
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  title,
  body,
  content = '',
  contentless_delete = 1
);

-- 削除チェックの進み具合(ブログ単位)。entrylist を1ページ目から順に読み直し、
-- 前のページの最古ID(prev_min)〜このページの最古ID の範囲で「こちらにあるのに一覧に無い」記事を探す。
-- 範囲をIDでつなぐので、途中で新着が増えてページがずれても確認漏れが出ない。
CREATE TABLE IF NOT EXISTS checks (
  blog       TEXT PRIMARY KEY,
  page       INTEGER NOT NULL DEFAULT 1,
  prev_min   INTEGER,
  cycles     INTEGER NOT NULL DEFAULT 0,   -- 最後まで見終えた回数
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS entries_blog_id ON entries(blog, entry_id);

-- 日付で見る(カレンダー)用。published は "2016-03-05T21:00:00.000+09:00"(日本時間)の文字列なので前方一致で月・日を引ける
CREATE INDEX IF NOT EXISTS entries_member_pub ON entries(member_no, published);
CREATE INDEX IF NOT EXISTS entries_pub ON entries(published);

-- グループでの絞り込み用。SNSスプシの GroupNo/SubGroup 行(番号)と affiliation 行(現役判定)から作る。
CREATE TABLE IF NOT EXISTS groups (
  group_no INTEGER PRIMARY KEY,
  name     TEXT NOT NULL
);

-- member_meta.groups は ",11,12," の形(LIKE で引くため前後にもカンマを付ける)
CREATE TABLE IF NOT EXISTS member_meta (
  member_no INTEGER PRIMARY KEY,
  groups    TEXT,
  active    INTEGER NOT NULL DEFAULT 0   -- ハロプロ現役なら1
);
