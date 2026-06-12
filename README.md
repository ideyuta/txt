# txt。

iCloud に保存できる、紙のように静かなメモ帳。ビルド不要の静的 Web アプリです。

**公開 URL:** https://ideyuta.github.io/txt/

- メモの作成・編集・削除・検索、自動保存（⌘N 新規 / ⌘S 即時保存）
- 保存先は 2 段構え
  - **未設定時:** ブラウザの localStorage（開いてすぐ使えます）
  - **設定後:** あなたの iCloud プライベートデータベース（CloudKit JS 経由・Apple ID でサインイン）
- ローカルのメモを iCloud へコピーする移行ボタンつき

## 使い方

1. https://ideyuta.github.io/txt/ を開く
2. そのまま書けば localStorage に自動保存されます
3. iCloud に保存したい場合は、下記セットアップ後に左下の「ローカル保存」チップ → 設定からコンテナ ID と API トークンを入力

## iCloud 同期のセットアップ

CloudKit は Apple のサービスのため、**Apple Developer Program（有料）のアカウントが必要**です。

### 1. CloudKit コンテナを作る

1. [Apple Developer](https://developer.apple.com/account/) → Certificates, Identifiers & Profiles → Identifiers
2. iCloud Containers で新規作成（例: `iCloud.com.example.txt`）

### 2. スキーマを定義する

[CloudKit Console](https://icloud.developer.apple.com/) で対象コンテナを開き、**Schema → Record Types** に `Note` を作成:

| フィールド | 型 |
| --- | --- |
| `title` | String |
| `body` | String |
| `updatedAt` | Int(64) |

**Indexes** で `Note` に以下を追加（これがないと一覧取得が `BAD_REQUEST` になります）:

- `recordName` … Queryable

development 環境で動作確認後、**Deploy Schema Changes** で production にも反映できます。

### 3. API トークンを発行する

CloudKit Console → 対象コンテナ → **API Access → CloudKit JS** で New Token を作成し、64 文字のトークンを控えます。

> CloudKit JS の API トークンはクライアント埋め込み前提の公開トークンです。データへのアクセスには各ユーザー自身の Apple ID サインインが必要なため、トークンだけでは他人のメモは読めません。

### 4. アプリに設定する

公開ページ左下の「ローカル保存」チップ（または歯車アイコン）→ 設定画面で以下を入力して「保存して接続」:

- コンテナ ID（例: `iCloud.com.example.txt`）
- API トークン
- 環境（まず `development` で動作確認 → スキーマ deploy 後に `production`）

Apple ID サインインボタンが表示されるのでサインインすると、以降のメモは iCloud に保存されます。設定はブラウザの localStorage にのみ保存され、サーバーには送信されません。

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
app.js       ロジック（LocalStore / CloudStore の 2 ストレージ）
```
