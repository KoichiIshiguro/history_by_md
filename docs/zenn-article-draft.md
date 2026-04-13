---
title: "Logseqが重すぎたので、ブラウザだけで動く軽量版を自作した【Next.js + SQLite】"
emoji: "📝"
type: "tech"
topics: ["nextjs", "react", "sqlite", "個人開発", "oss"]
published: false
---

## TL;DR

Logseqやobsidianは高機能だけど重い。Notionはクラウド依存。
**自分のサーバーで動く、軽量なブロックエディタ型ノートアプリ**をNext.js + SQLiteで作った。

GitHub: https://github.com/KoichiIshiguro/history_by_md

## なぜ作ったのか

日々のメモや考えを記録するツールとして、Logseqを使っていた。
ブロック単位の編集、タグ、バックリンク——Logseqの思想は好きだった。

でも不満があった。

- **起動が遅い**。Electronアプリなので毎回数秒待つ
- **ファイルが散らばる**。Markdownファイルが大量にできる
- **モバイルが弱い**。スマホからサッと確認したい場面で使いづらい
- **カスタマイズが面倒**。CSS/プラグインをいじるのが億劫

「ブラウザで開いて、すぐ書けて、スマホでも使えるやつが欲しい」

ないなら作るか、と思ったのがきっかけ。

## 何ができるのか

### ブロックエディタ

Logseqと同じ、ブロック（行）単位の編集。

- Enterで行分割、Backspaceで行結合
- Tab / Shift+Tabでインデント操作
- Ctrl+Z / Ctrl+Shift+Zでundo/redo
- Shift+クリックで複数行選択 → Delete/コピー/カット

### Markdown対応

GFM (GitHub Flavored Markdown)をフルサポート。

- テーブル、コードブロック、タスクリスト
- Mermaidダイアグラム（CDN読み込み）
- 画像、リンク、取り消し線

### 3つの軸で整理

| 軸 | 説明 |
|---|---|
| **日付** | 日記のように日ごとに書く |
| **ページ** | テーマごとにまとめる。階層構造対応 |
| **タグ** | `#タグ名` で横断的に分類 |

### バックリンク

`{{ページ名}}` と書くと、参照先のページに自動でバックリンクが表示される。
ページは階層対応で `{{親ページ/子ページ}}` のようなパス指定も可能。

### アクションフラグ

`!action` と書くと赤い丸(●)、`!done` で緑の丸(●)。
タスク管理を軽量に。全アクション一覧画面で未完了のアクションを横断確認できる。

### テンプレート

よく使うブロックのパターンをテンプレートとして保存。
エディタで `!template` と打つとサジェストされ、選択するとテンプレート内容が展開される。

### テーマ切り替え

5色（オレンジ/ブルー/パープル/グリーン/ピンク）からワンクリックで切り替え。

### PWA対応

スマホのホーム画面に追加して、ネイティブアプリのように使える。
スワイプジェスチャーでサイドバーの開閉もできる。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フレームワーク | Next.js 16 (App Router) |
| UI | React 19 + Tailwind CSS v4 |
| データベース | SQLite (better-sqlite3) |
| 認証 | NextAuth.js v5 (Google OAuth) |
| Markdown | react-markdown + remark-gfm + rehype-raw |
| 図表 | Mermaid (CDN) |

### なぜSQLiteか

- **デプロイが簡単**。ファイル1つ。PostgreSQLやMySQLのセットアップ不要
- **高速**。ローカルファイルなのでネットワーク遅延ゼロ
- **バックアップが楽**。ファイルをコピーするだけ
- **個人ユース〜小チームなら十分**。同時書き込みが少なければSQLiteで全く問題ない

### Tailwind CSS v4のCSS変数テーマ

テーマ切り替えはCSS custom properties + Tailwind v4の`@theme inline`で実現。

```css
:root {
  --theme-50: #fff7ed;
  --theme-500: #f97316;
  --theme-700: #c2410c;
}

@theme inline {
  --color-theme-50: var(--theme-50);
  --color-theme-500: var(--theme-500);
  --color-theme-700: var(--theme-700);
}
```

JavaScriptからCSS変数を書き換えるだけで、Tailwindのクラス（`bg-theme-50`, `text-theme-600`等）が動的に反応する。ランタイムのクラス付け替え不要。

### ブロック保存とタグ継承

親ブロックに`#タグ`があると、子ブロックにもそのタグが自動継承される。
これはLogseqと同じ挙動で、ブロック保存時にインデントスタックをたどって計算している。

## 開発のこだわり

### Claude Codeで爆速開発

このアプリはClaude Code（Anthropic公式CLI）を使って開発した。

「テンプレート機能を追加して」「テーマ切り替えをつけて」と指示すると、
DB設計→API→フロントエンドまで一気に実装してくれる。

人間がやったのは**設計方針を決めること**と**動作確認**。
コーディングの大部分はAIが担当した。

個人開発でも、この規模のアプリが短期間で形になるのはAI時代ならでは。

### セルフホスト前提

データは全て自分のサーバー上のSQLiteファイルに入る。
クラウドサービスに依存しない。サービス終了リスクゼロ。
`data/app.db` をバックアップするだけでデータ保全できる。

## セットアップ

```bash
git clone https://github.com/KoichiIshiguro/history_by_md.git
cd history_by_md
npm install
cp .env.example .env.local
# .env.localにGoogle OAuthの認証情報を設定
npm run dev
```

必要な環境変数：

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_SECRET=...
NEXTAUTH_URL=http://localhost:3000
```

## 今後のロードマップ

- [ ] Docker対応（ワンコマンドで起動）
- [ ] グラフビュー（ページ間の関係を可視化）
- [ ] 全文検索
- [ ] インポート/エクスポート（Markdown, Logseq形式）
- [ ] コラボレーション機能

## おわりに

「自分が毎日使いたいツール」を作った結果、思ったより便利なものになった。

Logseqの思想が好きだけど、もっと軽くてシンプルなものが欲しい人に届けば嬉しい。

OSSなので、PRも歓迎。Star押してもらえると開発のモチベーションになります。

GitHub: https://github.com/KoichiIshiguro/history_by_md
