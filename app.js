/* ───────────────────────────────────────────
   txt。 — クラウドに綴じるメモ帳

   保存先は 3 種:
   - DriveStore: Google ドライブ（drive.file 最小スコープ）。
     1 メモ = 1 Markdown。全ブラウザ・iPhone 対応。
     トークンはメモリのみに保持し、永続化しない。
   - FolderStore: File System Access API でユーザーが選んだ
     フォルダ（iCloud Drive 内を想定）に 1 メモ = 1 Markdown。
     同期は iCloud Drive 任せ。Chromium デスクトップ限定。
   - LocalStore: 未接続時の localStorage。
   ─────────────────────────────────────────── */

"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  app: $("app"),
  list: $("note-list"),
  search: $("search"),
  btnNew: $("btn-new"),
  btnBack: $("btn-back"),
  btnDelete: $("btn-delete"),
  btnSettings: $("btn-settings"),
  syncChip: $("sync-chip"),
  syncDot: $("sync-dot"),
  syncLabel: $("sync-label"),
  saveState: $("save-state"),
  editorBody: $("editor-body"),
  emptyState: $("empty-state"),
  title: $("note-title"),
  body: $("note-body"),
  meta: $("editor-meta"),
  dialog: $("settings-dialog"),
  settingsStatus: $("settings-status"),
  driveClientId: $("drive-client-id"),
  btnDriveConnect: $("btn-drive-connect"),
  btnDriveDisconnect: $("btn-drive-disconnect"),
  btnChooseFolder: $("btn-choose-folder"),
  btnDisconnect: $("btn-disconnect"),
  btnMigrate: $("btn-migrate"),
  btnExport: $("btn-export"),
  btnImport: $("btn-import"),
  importFile: $("import-file"),
  toast: $("toast"),
};

const NOTES_KEY = "txt.notes.v1";
const MODE_KEY = "txt.mode"; // "drive" | "folder" | "local"
const DRIVE_CFG_KEY = "txt.drive.cfg"; // { clientId, folderId } トークンは保存しない
const FS_SUPPORTED = "showDirectoryPicker" in window;

/* ───────── IndexedDB（ディレクトリハンドルの永続化） ───────── */

const idb = {
  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("txt-db", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async get(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async set(key, value) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async del(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};

/* ───────── ローカル保存 ───────── */

const LocalStore = {
  kind: "local",
  _read() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; }
    catch { return []; }
  },
  _write(notes) { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); },
  async list() { return this._read().sort((a, b) => b.updatedAt - a.updatedAt); },
  async save(note) {
    const notes = this._read();
    const i = notes.findIndex((n) => n.id === note.id);
    if (i >= 0) notes[i] = note; else notes.unshift(note);
    this._write(notes);
    return note;
  },
  async remove(id) { this._write(this._read().filter((n) => n.id !== id)); },
};

/* ───────── フォルダ保存（File System Access API） ───────── */

// ファイル名 = サニタイズ済みタイトル + 4 文字 id + .md
// 例: 買い物リスト.k3x9.md。id でリネーム時の同一性を担保する。
const FILE_RE = /^(.*)\.([a-z0-9]{4})\.md$/;

function parseFileName(name) {
  const m = name.match(FILE_RE);
  if (m) return { title: m[1], suffix: m[2] };
  // 手動でフォルダに置かれた素の .md も一覧に出す
  return { title: name.replace(/\.md$/, ""), suffix: null };
}

function sanitizeTitle(title) {
  const clean = title
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, "");
  return clean || "無題";
}

function newSuffix() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

const FolderStore = {
  kind: "folder",
  dir: null,
  async list() {
    const notes = [];
    for await (const entry of this.dir.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      const file = await entry.getFile();
      notes.push({
        id: entry.name,
        title: parseFileName(entry.name).title,
        body: await file.text(),
        updatedAt: file.lastModified,
      });
    }
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async save(note) {
    const existing = note.id.startsWith("l_") ? null : note.id;
    const suffix = (existing && parseFileName(existing).suffix) || newSuffix();
    const desired = `${sanitizeTitle(note.title)}.${suffix}.md`;

    let handle = null;
    if (existing) {
      try { handle = await this.dir.getFileHandle(existing); }
      catch { handle = null; } // 他端末で削除 / 改名済み → 新規作成にフォールバック
    }
    if (handle && existing !== desired) {
      if (typeof handle.move === "function") {
        await handle.move(desired);
      } else {
        handle = null;
        await this.dir.removeEntry(existing).catch(() => {});
      }
    }
    if (!handle) handle = await this.dir.getFileHandle(desired, { create: true });

    const writable = await handle.createWritable();
    await writable.write(note.body);
    await writable.close();
    const file = await handle.getFile();
    return { ...note, id: desired, updatedAt: file.lastModified };
  },
  async remove(id) { await this.dir.removeEntry(id); },
};

/* ───────── Google ドライブ保存 ───────── */

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FOLDER_NAME = "txt メモ";

function loadDriveCfg() {
  try { return JSON.parse(localStorage.getItem(DRIVE_CFG_KEY)) || {}; }
  catch { return {}; }
}

function saveDriveCfg(cfg) { localStorage.setItem(DRIVE_CFG_KEY, JSON.stringify(cfg)); }

const Drive = {
  clientId: null,
  token: null, // アクセストークンはメモリのみ（XSS 耐性のため永続化しない）
  tokenExp: 0,
  tokenClient: null,

  async loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = GIS_SRC;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Google ログインライブラリを読み込めませんでした"));
      document.head.appendChild(s);
    });
  },

  async getToken() {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    await this.loadGis();
    if (!this.tokenClient || this._tokenClientId !== this.clientId) {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_SCOPE,
        callback: () => {},
      });
      this._tokenClientId = this.clientId;
    }
    return new Promise((resolve, reject) => {
      const fail = (message) => {
        const err = new Error(message);
        err.name = "NotAllowedError";
        reject(err);
      };
      this.tokenClient.callback = (resp) => {
        if (resp.error) return fail(resp.error);
        this.token = resp.access_token;
        this.tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        resolve(this.token);
      };
      this.tokenClient.error_callback = (err) => fail(err && err.message ? err.message : "popup_blocked");
      this.tokenClient.requestAccessToken({ prompt: "" });
    });
  },

  async fetch(url, options = {}, retry = true) {
    const token = await this.getToken();
    const res = await window.fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && retry) {
      this.token = null; // 失効 → 取り直して 1 回だけ再試行
      return this.fetch(url, options, false);
    }
    if (!res.ok) {
      const err = new Error(`Drive API ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  },

  // アプリ専用フォルダ（drive.file スコープではこのアプリが作ったものだけ見える）
  async ensureFolder() {
    const cfg = loadDriveCfg();
    if (cfg.folderId) {
      try {
        const res = await this.fetch(`${DRIVE_API}/files/${cfg.folderId}?fields=id,trashed`);
        const f = await res.json();
        if (!f.trashed) return cfg.folderId;
      } catch { /* 消えていたら作り直す */ }
    }
    const q = encodeURIComponent(
      `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const found = await (await this.fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`)).json();
    if (found.files && found.files.length > 0) return found.files[0].id;

    const created = await (await this.fetch(`${DRIVE_API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    })).json();
    return created.id;
  },
};

const DriveStore = {
  kind: "drive",
  folderId: null,
  async list() {
    const q = encodeURIComponent(
      `'${this.folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`
    );
    const res = await Drive.fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1000`);
    const { files = [] } = await res.json();
    const notes = await Promise.all(files.map(async (f) => ({
      id: f.id,
      title: f.name.replace(/\.md$/, ""),
      body: await (await Drive.fetch(`${DRIVE_API}/files/${f.id}?alt=media`)).text(),
      updatedAt: Date.parse(f.modifiedTime) || Date.now(),
    })));
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async save(note) {
    const isNew = note.id.startsWith("l_");
    const metadata = { name: sanitizeTitle(note.title) + ".md", mimeType: "text/markdown" };
    if (isNew) metadata.parents = [this.folderId];

    // メタデータ + 本文を 1 リクエストで送る multipart アップロード
    const boundary = "txtb" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${note.body}\r\n--${boundary}--`;
    const url = isNew
      ? `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime`
      : `${DRIVE_UPLOAD}/files/${note.id}?uploadType=multipart&fields=id,name,modifiedTime`;

    const res = await Drive.fetch(url, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    const f = await res.json();
    return { ...note, id: f.id, updatedAt: Date.parse(f.modifiedTime) || Date.now() };
  },
  async remove(id) {
    // 完全削除ではなくゴミ箱へ（誤削除から復元できる）
    await Drive.fetch(`${DRIVE_API}/files/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  },
};

/* ───────── 状態 ───────── */

const state = {
  store: LocalStore,
  notes: [],
  currentId: null,
  query: "",
  dirty: false,
  saveTimer: null,
  saving: Promise.resolve(),
  pendingDir: null,   // フォルダ: 権限の再付与待ちハンドル
  drivePending: false, // Drive: サイレント再認証に失敗し、クリック待ち
};

/* ───────── UI ヘルパー ───────── */

let toastTimer = null;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function setSyncStatus(mode, label) {
  els.syncDot.className = "sync-dot" + (mode ? " " + mode : "");
  els.syncLabel.textContent = label;
}

function setSaveState(mode, label) {
  els.saveState.className = "save-state" + (mode ? " " + mode : "");
  els.saveState.textContent = label;
}

function formatDate(ms) {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
}

function currentNote() {
  return state.notes.find((n) => n.id === state.currentId) || null;
}

function fsErrorMessage(err, fallback) {
  if (err && err.name === "NotAllowedError") return "保存先へのアクセスが許可されていません（左下のチップから再接続）";
  if (err && err.name === "NotFoundError") return "保存先のフォルダ / ファイルが見つかりません";
  if (err && err.name === "QuotaExceededError") return "ストレージ容量が不足しています";
  if (err && err.status === 403) return "Google ドライブの権限が不足しています（再接続してください）";
  if (err && err.status === 404) return "Google ドライブ上にファイルが見つかりません";
  if (err && err.status >= 500) return "Google ドライブが一時的に応答していません";
  return fallback;
}

/* ───────── 描画 ───────── */

function renderList() {
  const q = state.query.trim().toLowerCase();
  const filtered = q
    ? state.notes.filter((n) => (n.title + "\n" + n.body).toLowerCase().includes(q))
    : state.notes;

  els.list.innerHTML = "";
  if (filtered.length === 0) {
    const div = document.createElement("div");
    div.className = "note-list-empty";
    div.textContent = q ? "見つかりませんでした" : "メモはまだありません";
    els.list.appendChild(div);
    return;
  }

  for (const note of filtered) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "note-item" + (note.id === state.currentId ? " active" : "");

    const title = document.createElement("div");
    title.className = "note-item-title" + (note.title ? "" : " untitled");
    title.textContent = note.title || "無題";

    const snippet = document.createElement("div");
    snippet.className = "note-item-snippet";
    snippet.textContent = note.body.replace(/\s+/g, " ").slice(0, 60) || "　";

    const date = document.createElement("div");
    date.className = "note-item-date";
    date.textContent = formatDate(note.updatedAt);

    item.append(title, snippet, date);
    item.addEventListener("click", () => openNote(note.id));
    els.list.appendChild(item);
  }
}

function renderEditor() {
  const note = currentNote();
  if (!note) {
    els.editorBody.hidden = true;
    els.emptyState.hidden = false;
    els.btnDelete.hidden = true;
    els.app.classList.remove("editing");
    setSaveState("", "");
    return;
  }
  els.editorBody.hidden = false;
  els.emptyState.hidden = true;
  els.btnDelete.hidden = false;
  if (els.title.value !== note.title) els.title.value = note.title;
  if (els.body.value !== note.body) els.body.value = note.body;
  renderMeta(note);
}

function renderMeta(note) {
  const chars = (note.title + note.body).length;
  els.meta.innerHTML = "";
  const date = document.createElement("span");
  date.textContent = "更新 " + new Date(note.updatedAt).toLocaleString("ja-JP");
  const count = document.createElement("span");
  count.textContent = chars.toLocaleString("ja-JP") + " 字";
  els.meta.append(date, count);
}

/* ───────── 操作 ───────── */

async function openNote(id) {
  await flushSave();
  state.currentId = id;
  els.app.classList.add("editing");
  renderList();
  renderEditor();
}

async function newNote() {
  await flushSave();
  const note = {
    id: "l_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    title: "",
    body: "",
    updatedAt: Date.now(),
  };
  state.notes.unshift(note);
  state.currentId = note.id;
  state.dirty = true;
  scheduleSave();
  els.app.classList.add("editing");
  renderList();
  renderEditor();
  els.title.focus();
}

async function deleteNote() {
  const note = currentNote();
  if (!note) return;
  const label = note.title || "無題のメモ";
  if (!confirm(`「${label}」を削除しますか？この操作は取り消せません。`)) return;

  clearTimeout(state.saveTimer);
  state.dirty = false;
  try {
    if (!note.id.startsWith("l_")) {
      await state.store.remove(note.id);
    } else if (state.store.kind === "local") {
      await state.store.remove(note.id);
    }
    state.notes = state.notes.filter((n) => n.id !== note.id);
    state.currentId = null;
    renderList();
    renderEditor();
    toast("メモを削除しました");
  } catch (err) {
    console.error(err);
    toast(fsErrorMessage(err, "削除に失敗しました"), true);
  }
}

function onEdit() {
  const note = currentNote();
  if (!note) return;
  note.title = els.title.value;
  note.body = els.body.value;
  note.updatedAt = Date.now();
  state.dirty = true;
  renderMeta(note);
  scheduleSave();
}

function scheduleSave() {
  setSaveState("saving", "未保存…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 700);
}

function saveNow() {
  if (!state.dirty) return;
  const note = currentNote();
  if (!note) return;
  state.dirty = false;

  // 保存は直列化して順序を保証する
  state.saving = state.saving.then(async () => {
    setSaveState("saving", "保存中…");
    try {
      const saved = await state.store.save({ ...note });
      if (saved.id !== note.id) {
        if (state.currentId === note.id) state.currentId = saved.id;
        note.id = saved.id;
      }
      note.updatedAt = saved.updatedAt;
      const savedLabel = { drive: "Google ドライブに保存済み", folder: "フォルダに保存済み", local: "このブラウザに保存済み" };
      setSaveState("saved", savedLabel[state.store.kind]);
      renderList();
    } catch (err) {
      console.error("save failed:", err);
      state.dirty = true;
      setSaveState("error", "保存に失敗しました");
      toast(fsErrorMessage(err, "保存に失敗しました"), true);
    }
  });
}

async function flushSave() {
  if (state.dirty) {
    clearTimeout(state.saveTimer);
    saveNow();
  }
  await state.saving;
}

async function reloadNotes() {
  try {
    state.notes = await state.store.list();
    if (!currentNote()) state.currentId = null;
    renderList();
    renderEditor();
  } catch (err) {
    console.error("list failed:", err);
    toast(fsErrorMessage(err, "メモ一覧の取得に失敗しました"), true);
  }
}

/* ───────── フォルダ接続 ───────── */

async function chooseFolder() {
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    await flushSave();
    await idb.set("dir", dir);
    state.pendingDir = null;
    localStorage.setItem(MODE_KEY, "folder");
    await enterFolderMode(dir);
    els.dialog.close();
    toast(`「${dir.name}」と接続しました`);
  } catch (err) {
    if (err && err.name === "AbortError") return; // ユーザーがキャンセル
    console.error(err);
    toast(fsErrorMessage(err, "フォルダを開けませんでした"), true);
  }
}

async function reconnectFolder() {
  const dir = state.pendingDir;
  if (!dir) return;
  try {
    const perm = await dir.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      state.pendingDir = null;
      await enterFolderMode(dir);
      toast(`「${dir.name}」に再接続しました`);
    } else {
      toast("アクセスが許可されませんでした", true);
    }
  } catch (err) {
    console.error(err);
    toast(fsErrorMessage(err, "再接続に失敗しました"), true);
  }
}

async function disconnectFolder() {
  if (!confirm("フォルダ接続を解除しますか？（フォルダ内の .md ファイルは残ります）")) return;
  await idb.del("dir");
  state.pendingDir = null;
  localStorage.setItem(MODE_KEY, "local");
  enterLocalMode();
  toast("フォルダ接続を解除しました");
}

async function enterFolderMode(dir) {
  FolderStore.dir = dir;
  state.store = FolderStore;
  state.currentId = null;
  state.drivePending = false;
  setSyncStatus("cloud", dir.name ? `フォルダと同期中: ${dir.name}` : "フォルダと同期中");
  await reloadNotes();
  renderSettings();
}

function enterLocalMode(label) {
  state.store = LocalStore;
  state.currentId = null;
  setSyncStatus(state.pendingDir || state.drivePending ? "pending" : "", label || "ローカル保存");
  reloadNotes();
  renderSettings();
}

/* ───────── Google ドライブ接続 ───────── */

async function connectDrive() {
  const clientId = els.driveClientId.value.trim();
  if (!clientId) {
    toast("OAuth クライアント ID を入力してください（取得手順は README）", true);
    return;
  }
  els.btnDriveConnect.disabled = true;
  try {
    await flushSave();
    Drive.clientId = clientId;
    Drive.token = null;
    await Drive.getToken(); // 初回はここで Google の同意ポップアップが開く
    const folderId = await Drive.ensureFolder();
    saveDriveCfg({ clientId, folderId });
    localStorage.setItem(MODE_KEY, "drive");
    state.drivePending = false;
    await enterDriveMode();
    els.dialog.close();
    toast("Google ドライブと接続しました");
  } catch (err) {
    console.error(err);
    toast(fsErrorMessage(err, "Google ドライブに接続できませんでした"), true);
  } finally {
    els.btnDriveConnect.disabled = false;
  }
}

// 再訪時のサイレント再認証。ポップアップブロック等で失敗したらクリック待ちにする
async function resumeDrive() {
  const cfg = loadDriveCfg();
  Drive.clientId = cfg.clientId;
  try {
    await Drive.getToken();
    DriveStore.folderId = await Drive.ensureFolder();
    saveDriveCfg({ ...cfg, folderId: DriveStore.folderId });
    state.drivePending = false;
    await enterDriveMode();
  } catch (err) {
    console.error("drive resume failed:", err);
    state.drivePending = true;
    enterLocalMode("Google に再接続（クリック）");
  }
}

async function disconnectDrive() {
  if (!confirm("Google ドライブ接続を解除しますか？（ドライブ上のメモは残ります）")) return;
  try {
    if (Drive.token && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(Drive.token, () => {});
    }
  } catch { /* revoke は失敗しても続行 */ }
  Drive.token = null;
  localStorage.removeItem(DRIVE_CFG_KEY);
  localStorage.setItem(MODE_KEY, "local");
  state.drivePending = false;
  enterLocalMode();
  toast("Google ドライブ接続を解除しました");
}

async function enterDriveMode() {
  if (!DriveStore.folderId) DriveStore.folderId = loadDriveCfg().folderId;
  state.store = DriveStore;
  state.currentId = null;
  state.pendingDir = null;
  setSyncStatus("cloud", "Google ドライブと同期中");
  await reloadNotes();
  renderSettings();
}

// 他端末の変更（Drive / iCloud Drive 側で更新されたファイル）を拾う
let lastRefresh = 0;
function refreshFromRemote() {
  if (state.store.kind === "local" || state.dirty) return;
  if (Date.now() - lastRefresh < 4000) return;
  lastRefresh = Date.now();
  reloadNotes();
}

/* ───────── 移行・エクスポート ───────── */

async function migrateLocalNotes() {
  if (state.store.kind === "local") return;
  const dest = state.store.kind === "drive" ? "Google ドライブ" : "フォルダ";
  const localNotes = LocalStore._read();
  if (localNotes.length === 0) return;
  if (!confirm(`このブラウザに保存された ${localNotes.length} 件のメモを${dest}へコピーします。よろしいですか？`)) return;

  els.btnMigrate.disabled = true;
  let ok = 0;
  try {
    for (const note of localNotes) {
      await state.store.save({ ...note, id: "l_migrate" });
      ok++;
    }
    localStorage.removeItem(NOTES_KEY);
    toast(`${ok} 件のメモを${dest}へコピーしました`);
    await reloadNotes();
    renderSettings();
  } catch (err) {
    console.error(err);
    toast(`${ok} 件コピー後に失敗しました。再度お試しください`, true);
  } finally {
    els.btnMigrate.disabled = false;
  }
}

function exportNotes() {
  const data = JSON.stringify(
    state.notes.map(({ title, body, updatedAt }) => ({ title, body, updatedAt })),
    null, 2
  );
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `txt-notes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`${state.notes.length} 件をエクスポートしました`);
}

async function importNotes(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed)) throw new Error("not an array");
    let ok = 0;
    for (const item of parsed) {
      if (typeof item.body !== "string" && typeof item.title !== "string") continue;
      await state.store.save({
        id: "l_import" + Math.random().toString(36).slice(2, 8),
        title: String(item.title || ""),
        body: String(item.body || ""),
        updatedAt: Number(item.updatedAt) || Date.now(),
      });
      ok++;
    }
    await reloadNotes();
    toast(`${ok} 件をインポートしました`);
  } catch (err) {
    console.error(err);
    toast("インポートに失敗しました（JSON 形式を確認してください）", true);
  }
}

/* ───────── 設定モーダル ───────── */

function renderSettings() {
  const kind = state.store.kind;
  const folderPending = !!state.pendingDir;

  let status;
  if (kind === "drive") {
    status = `Google ドライブと接続中。メモはドライブの「${DRIVE_FOLDER_NAME}」フォルダに`
      + " 1 件 = 1 つの .md ファイルとして保存され、どのブラウザ・iPhone からでも開けます。";
  } else if (kind === "folder") {
    const name = FolderStore.dir && FolderStore.dir.name;
    status = `フォルダ${name ? `「${name}」` : ""}と接続中。メモは 1 件 = 1 つの .md ファイルとして保存され、`
      + "iCloud Drive 内のフォルダなら Apple が自動同期します。iPhone からはファイル.app で読めます。";
  } else if (state.drivePending) {
    status = "Google ドライブへの再接続待ちです。「Google ドライブに接続」を押すと再開します。";
  } else if (folderPending) {
    status = `前回のフォルダ「${state.pendingDir.name}」への再接続待ちです。`
      + "ブラウザのセキュリティ上、再訪時はワンクリックの再許可が必要な場合があります。";
  } else {
    status = "メモは現在このブラウザ内（localStorage）に保存されています。"
      + "Google ドライブに接続すると全ブラウザ・iPhone で同期でき、"
      + "フォルダ（Chrome / Edge のみ）を選ぶと iCloud Drive 経由で同期できます。"
      + "※Safari は 7 日間アクセスがないとブラウザ内データを削除することがあります。";
  }
  els.settingsStatus.textContent = status;

  // Google ドライブ
  const cfg = loadDriveCfg();
  if (!els.driveClientId.value && cfg.clientId) els.driveClientId.value = cfg.clientId;
  els.btnDriveConnect.textContent = kind === "drive" ? "再接続 / アカウント切替"
    : state.drivePending ? "Google ドライブに再接続"
    : "Google ドライブに接続";
  els.btnDriveDisconnect.hidden = !(kind === "drive" || cfg.clientId);

  // フォルダ
  els.btnChooseFolder.disabled = !FS_SUPPORTED;
  if (!FS_SUPPORTED) {
    els.btnChooseFolder.textContent = "このブラウザは非対応（Chrome / Edge のみ）";
  } else {
    els.btnChooseFolder.textContent = folderPending ? "前回のフォルダに再接続"
      : kind === "folder" ? "別のフォルダに変更…"
      : "保存先フォルダを選択…";
  }
  els.btnDisconnect.hidden = kind !== "folder";

  els.btnMigrate.hidden = !(kind !== "local" && LocalStore._read().length > 0);
}

function openSettings() {
  renderSettings();
  els.dialog.showModal();
}

/* ───────── 起動 ───────── */

function bindEvents() {
  els.btnNew.addEventListener("click", newNote);
  els.btnDelete.addEventListener("click", deleteNote);
  els.btnBack.addEventListener("click", async () => {
    await flushSave();
    els.app.classList.remove("editing");
    renderList();
  });
  els.title.addEventListener("input", onEdit);
  els.body.addEventListener("input", onEdit);
  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderList();
  });

  els.btnSettings.addEventListener("click", openSettings);
  els.syncChip.addEventListener("click", () => {
    // 再接続待ちならチップから直接再許可（ユーザー操作が必要なため）
    if (state.pendingDir) reconnectFolder();
    else if (state.drivePending) resumeDrive();
    else openSettings();
  });
  els.btnDriveConnect.addEventListener("click", connectDrive);
  els.btnDriveDisconnect.addEventListener("click", disconnectDrive);
  els.btnChooseFolder.addEventListener("click", () => {
    if (state.pendingDir) reconnectFolder();
    else chooseFolder();
  });
  els.btnDisconnect.addEventListener("click", disconnectFolder);
  els.btnMigrate.addEventListener("click", migrateLocalNotes);
  els.btnExport.addEventListener("click", exportNotes);
  els.btnImport.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", () => {
    if (els.importFile.files[0]) importNotes(els.importFile.files[0]);
    els.importFile.value = "";
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "n") {
      e.preventDefault();
      newNote();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      flushSave();
    }
  });

  window.addEventListener("focus", refreshFromRemote);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSave();
    else refreshFromRemote();
  });
  window.addEventListener("beforeunload", () => {
    if (state.dirty) saveNow();
  });
}

async function init() {
  bindEvents();

  const params = new URLSearchParams(location.search);

  // テスト用フック: ?opfs で OPFS ルートを保存先にする（picker はヘッドレスで操作不能のため）
  if (params.has("opfs")) {
    const dir = await navigator.storage.getDirectory();
    await enterFolderMode(dir);
    return;
  }
  // テスト用フック: ?mockdrive で偽トークンを差して Drive 経路を通す（API はテスト側でモック）
  if (params.has("mockdrive")) {
    Drive.clientId = "mock-client";
    Drive.token = "mock-token";
    Drive.tokenExp = Date.now() + 3600 * 1000;
    DriveStore.folderId = "mock-folder";
    await enterDriveMode();
    return;
  }

  const mode = localStorage.getItem(MODE_KEY)
    || (loadDriveCfg().clientId ? "drive" : "folder"); // 旧バージョンからの引き継ぎ

  if (mode === "drive" && loadDriveCfg().clientId) {
    await resumeDrive();
    return;
  }

  if (mode === "folder" && FS_SUPPORTED) {
    try {
      const saved = await idb.get("dir");
      if (saved) {
        const perm = typeof saved.queryPermission === "function"
          ? await saved.queryPermission({ mode: "readwrite" })
          : "prompt";
        if (perm === "granted") {
          await enterFolderMode(saved);
          return;
        }
        state.pendingDir = saved;
        enterLocalMode("フォルダ再接続が必要（クリック）");
        return;
      }
    } catch (err) {
      console.error("handle restore failed:", err);
    }
  }
  enterLocalMode();
}

init();
