# txt。

クラウドに綴じる、紙のように静かなメモ帳。ビルド不要・サーバーレスの静的 Web アプリです。

**公開 URL:** https://ideyuta.com/txt/ （https://ideyuta.github.io/txt/ からもリダイレクト）

- メモの作成・編集・削除・検索、自動保存（⌘N 新規 / ⌘S 即時保存）
- **1 メモ = 1 つの Markdown ファイル**として保存。保存先は 3 つから選べます

| 保存先 | 同期 | 対応環境 | セットアップ |
| --- | --- | --- | --- |
| **Google ドライブ** | ○ 全端末（iPhone 含む） | すべてのブラウザ | OAuth クライアント ID（初回のみ、下記） |
| **フォルダ**（iCloud Drive 等） | ○ Apple が同期 | Mac/Win の Chrome・Edge | フォルダを選ぶだけ |
| **ブラウザ内**（localStorage） | ✕ | すべて | 不要（初期状態） |

## Google ドライブで使う（推奨・iPhone 対応）

アプリ左下のチップ（または歯車）→ 設定 →「**Google ドライブに接続**」を押し、Google アカウントを選んで許可するだけです。クライアント ID は埋め込み済みなので入力は不要です。

メモはあなたのドライブの「txt メモ」フォルダに `.md` として保存されます。アプリは **`drive.file` 最小スコープ**（自分が作ったファイルのみアクセス可）で動き、アクセストークンはメモリと sessionStorage（タブを閉じると消える）にのみ保持します。

### 自分でホストする場合: OAuth クライアント ID の取得（無料・約 10 分）

1. [Google Cloud Console](https://console.cloud.google.com/) → 新しいプロジェクトを作成（名前は任意。例: `txt-memo`）
2. **API とサービス → ライブラリ** → 「Google Drive API」を検索して**有効化**
3. **API とサービス → OAuth 同意画面** → User Type は **外部** → アプリ名とメールアドレスを入力して作成 → **公開ステータスを「本番環境」に**（`drive.file` のみなら Google の審査は不要。「未確認のアプリ」と表示されますが自分用なら問題ありません）
4. **API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID** → 種類は **ウェブ アプリケーション**
5. **承認済みの JavaScript 生成元**に以下を追加:
   - `https://ideyuta.com`
   - `http://localhost:8000`（ローカル開発する場合）
6. 発行された**クライアント ID**（`xxxx.apps.googleusercontent.com`）をコピー

### アプリへの設定

1. アプリ左下のチップ（または歯車）→ 設定を開く
2. クライアント ID を貼り付けて「Google ドライブに接続」
3. Google のポップアップでアカウントを選んで許可 → 完了

トークンは約 1 時間有効で、リロードしてもそのまま引き継がれます。失効後は、ページ内のどこかを最初にクリックしたタイミングで自動再接続します（Google のポップアップが一瞬開いて自動で閉じます）。それでも繋がらない場合のみ左下のチップから手動で再接続してください。

## フォルダ（iCloud Drive）で使う

Mac の Chrome / Edge で、設定 → 「保存先フォルダを選択…」から iCloud Drive 内のフォルダを選ぶだけです。メモは `タイトル.xxxx.md`（末尾 4 文字はリネーム追跡用 id）として保存され、iPhone からは**ファイル.app** で読めます。フォルダを Obsidian の vault にすれば Obsidian とも併用できます。

## セキュリティ設計

- サーバー・共有 DB・シークレットを一切持たない静的サイト（クライアント ID は公開前提の値）
- Google のトークンはメモリ + sessionStorage のみ（タブを閉じると消える。localStorage には保存しない）
- `drive.file` スコープによりドライブ全体にはアクセス不能
- CSP で接続先を Google API / フォント配信のみに制限
- 非対応環境のメモは localStorage 保存。**Safari は 7 日間アクセスがないとサイトデータを削除する**ことがあるため、設定のエクスポートで控えを残せます

## 開発

ビルド不要。ローカルで確認する場合:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

構成:

```
index.html   マークアップ + CSP
style.css    スタイル（紙とインクのテーマ）
app.js       ロジック（LocalStore / FolderStore / DriveStore の 3 ストレージ）
```

テスト用フック:

- `?opfs` — フォルダの代わりに OPFS を保存先にして FolderStore 経路を headless で検証
- `?mockdrive` — 偽トークンで DriveStore 経路を有効化（Google API はテスト側で route モック）
