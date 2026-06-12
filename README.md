# txt。

iCloud Drive に保存できる、紙のように静かなメモ帳。ビルド不要の静的 Web アプリです。

**公開 URL:** https://ideyuta.com/txt/ （https://ideyuta.github.io/txt/ からもリダイレクト）

- メモの作成・編集・削除・検索、自動保存（⌘N 新規 / ⌘S 即時保存）
- **1 メモ = 1 つの Markdown ファイル**としてユーザーが選んだフォルダに保存
  - iCloud Drive 内のフォルダを選べば、Apple が自動で全端末に同期
  - 素の `.md` なので、ファイル.app や任意のエディタからもそのまま読み書き可能
- Apple Developer 登録・サーバー・アカウント一切不要
- JSON 一括エクスポート / インポート対応

## 使い方

1. **Mac の Chrome / Edge** で https://ideyuta.com/txt/ を開く
2. 左下の「ローカル保存」チップ →「保存先フォルダを選択…」
3. iCloud Drive 内のフォルダ（例: `iCloud Drive/メモ`）を選んで「保存」を許可
4. あとは書くだけ。メモは `タイトル.xxxx.md` として保存され、iCloud Drive が同期します

> 権限について: ハンドルはブラウザ内（IndexedDB）に永続化されます。再訪時に「前回のフォルダに再接続」のワンクリック再許可を求められることがありますが、Chrome 122 以降は許可ダイアログで「今後も許可」を選ぶと省略できます。

## 対応環境

| 環境 | フォルダ保存（iCloud Drive 同期） | ローカル保存 |
| --- | --- | --- |
| Mac / Windows の Chrome・Edge | ○ | ○（未接続時） |
| Safari（Mac / iPhone / iPad） | ✕（File System Access API 非対応） | ○ |
| iPhone / iPad の各ブラウザ | ✕（iOS は全ブラウザ非対応） | ○ |

- iPhone では、Mac で保存した `.md` を**ファイル.app から閲覧・編集**できます（この Web アプリからは開けません）
- 非対応ブラウザでは localStorage に保存されます。**Safari は 7 日間アクセスがないとサイトデータを削除する**ことがあるため、大事なメモは設定からエクスポートするか、フォルダ保存環境をお使いください

## データ形式

```
選んだフォルダ/
├── 買い物リスト.k3x9.md   ← 本文がそのまま入った素の Markdown
└── 会議メモ.a1b2.md       ← 末尾 4 文字はリネーム追跡用の id
```

ファイル名がタイトル、ファイル内容が本文、更新日時はファイルの mtime です。手動でフォルダに置いた `.md` も一覧に表示されます。

## 開発

ビルド不要。ローカルで確認する場合:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

構成:

```
index.html   マークアップ
style.css    スタイル（紙とインクのテーマ）
app.js       ロジック（LocalStore / FolderStore の 2 ストレージ）
```

テスト用に `?opfs` クエリを付けると、フォルダの代わりに OPFS（Origin Private File System）を保存先にしてフォルダ保存経路を headless ブラウザで検証できます。
