# アメブロ検索

https://ameblo.karin-archive.com

ハロー！プロジェクトのメンバーのアメブロを、本文と日付から探すサイト。

- 記事を定期的に取得し、本文を検索用に保存する。画面には一致箇所の前後だけを出し、記事は ameblo.jp へリンクする
- 画像・動画・アメンバー限定記事は保存しない

## 構成

| パス | 内容 |
|---|---|
| `src/worker.js` | Cloudflare Worker。検索API・取り込みAPI |
| `public/` | 画面 |
| `schema.sql` | D1 のテーブル |
| `crawler/crawl.py` | アメブロの記事を取得して Worker に送る |
| `.github/workflows/crawl.yml` | 取得の実行（毎時） |
| `.github/workflows/deploy.yml` | main への push でデプロイ |

## 取得

- 1秒に1リクエスト。並列にしない
- 1回の実行は最大50分・3000リクエスト
- 新着の取得、削除・編集の確認、過去記事の取得の順に行う
- 削除は、記事ページが無くなったことを確かめてから反映する
