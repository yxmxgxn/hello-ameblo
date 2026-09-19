# アメブロ検索

ハロプロメンバーのアメブロを本文から検索するサイト。karin-archive とは別の Worker（`hello-ameblo`）。

- 本文は D1 にだけ持ち、サイトには出さない。検索結果は一致箇所の前後数十字だけ見せて、記事は ameblo.jp へ飛ばす
- グループブログはテーマで誰の記事かを判別し、メンバーで絞り込める
- どのブログ・テーマが誰かは karin-archive の SNS スプシ（accounts タブの `ameblo` / `ameblo_g` 行）から毎回読む。スプシを直せば次のクロールで記事の紐づけも直る

## 構成

| パス | 役割 |
|---|---|
| `src/worker.js` | 検索API・クローラ用の取り込みAPI。bigram化もここ（正規化の実装を1か所にするため） |
| `public/` | 画面（静的アセット） |
| `schema.sql` | D1 のテーブル |
| `crawler/crawl.py` | アメブロを巡回して Worker に送る（標準ライブラリのみ） |
| `.github/workflows/crawl.yml` | 毎時クロール |
| `.github/workflows/deploy.yml` | main への push でスキーマ適用＋デプロイ |

### 検索の仕組み

インタビュー記事まとめと同じ。本文を NFKC→小文字→日本語・英数字以外を除去してから2文字ずつ区切った bigram を FTS5 に入れ、検索語も同じように bigram 化してフレーズ一致で引く（＝部分一致）。空白区切りで AND。漢字1文字だけの検索も可（かな1文字は重すぎるので不可）。
並びは記事ID順（アメブロの記事IDは時系列で増える）。「もっと見る」は OFFSET ではなく記事IDのカーソルなので、ヒットが多い語でも重くならない。

### クロールの仕組み

1回の実行（上限50分・リクエスト間隔1秒）で:
1. スプシの対応表を Worker に送る
2. 各ブログの新着を拾う（取り込み済みの最新IDより新しいもの）
3. 残りの時間で過去記事を1ページ（20件）ずつ、全ブログ順番に遡る

進み具合は D1 の `blogs` テーブルにあるので、実行が途中で切れても次回続きから。全74ブログ・約36万記事を遡り終えるまで1週間ほど。

## 立ち上げ手順

1. Cloudflare ダッシュボードで D1 を作る（名前 `hello-ameblo`）。ID を `wrangler.jsonc` の `database_id` に入れる
2. GitHub にリポジトリを作って push。Secrets に `CLOUDFLARE_API_TOKEN`（**D1 編集権限つき**）/ `CLOUDFLARE_ACCOUNT_ID` / `CRAWL_TOKEN`（適当な長いランダム文字列）、Variables に `CRAWL_API`（`https://hello-ameblo.<サブドメイン>.workers.dev`）
3. Worker のシークレットにも同じ `CRAWL_TOKEN` を登録（Workers & Pages → hello-ameblo → 設定 → 変数とシークレット）
4. Actions の Crawl を手動実行して動作確認

## ローカルで動かす

```bash
npx wrangler@4 d1 execute hello-ameblo --local --persist-to <作業用フォルダ> --file schema.sql
npx wrangler@4 dev --persist-to <作業用フォルダ> --var CRAWL_TOKEN:dev
python crawler/crawl.py --api http://localhost:8787 --token dev --blogs angerme-new --max-fetch 60
```
