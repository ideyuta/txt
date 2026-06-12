/* ───────────────────────────────────────────
   txt。 — iCloud Drive フォルダ + localStorage メモ帳

   保存先は 2 段構え:
   - FolderStore: File System Access API でユーザーが選んだ
     フォルダ（iCloud Drive 内を想定）に 1 メモ = 1 Markdown。
     同期は iCloud Drive 任せ。Chromium デスクトップ限定。
   - LocalStore: 非対応ブラウザ / 未接続時の localStorage。
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
  btnChooseFolder: $("btn-choose-folder"),
  btnDisconnect: $("btn-disconnect"),
  btnMigrate: $("btn-migrate"),
  btnExport: $("btn-export"),
  btnImport: $("btn-import"),
  importFile: $("import-file"),
  toast: $("toast"),
};

const NOTES_KEY = "txt.notes.v1";
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

/* ───────── 状態 ───────── */

const state = {
  store: LocalStore,
  notes: [],
  currentId: null,
  query: "",
  dirty: false,
  saveTimer: null,
  saving: Promise.resolve(),
  pendingDir: null, // 権限の再付与待ちハンドル
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
  if (err && err.name === "NotAllowedError") return "フォルダへのアクセスが許可されていません（設定から再接続）";
  if (err && err.name === "NotFoundError") return "保存先のフォルダ / ファイルが見つかりません";
  if (err && err.name === "QuotaExceededError") return "ストレージ容量が不足しています";
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
      setSaveState("saved", state.store.kind === "folder" ? "フォルダに保存済み" : "このブラウザに保存済み");
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
  enterLocalMode();
  renderSettings();
  toast("フォルダ接続を解除しました");
}

async function enterFolderMode(dir) {
  FolderStore.dir = dir;
  state.store = FolderStore;
  state.currentId = null;
  setSyncStatus("cloud", dir.name ? `フォルダと同期中: ${dir.name}` : "フォルダと同期中");
  await reloadNotes();
  renderSettings();
}

function enterLocalMode(label) {
  state.store = LocalStore;
  state.currentId = null;
  setSyncStatus(state.pendingDir ? "pending" : "", label || "ローカル保存");
  reloadNotes();
  renderSettings();
}

// 他端末の変更（iCloud Drive が背後で同期したファイル）を拾う
let lastRefresh = 0;
function refreshFromDisk() {
  if (state.store.kind !== "folder" || state.dirty) return;
  if (Date.now() - lastRefresh < 4000) return;
  lastRefresh = Date.now();
  reloadNotes();
}

/* ───────── 移行・エクスポート ───────── */

async function migrateLocalNotes() {
  const localNotes = LocalStore._read();
  if (localNotes.length === 0) return;
  if (!confirm(`このブラウザに保存された ${localNotes.length} 件のメモをフォルダへコピーします。よろしいですか？`)) return;

  els.btnMigrate.disabled = true;
  let ok = 0;
  try {
    for (const note of localNotes) {
      await FolderStore.save({ ...note, id: "l_migrate" });
      ok++;
    }
    localStorage.removeItem(NOTES_KEY);
    toast(`${ok} 件のメモをフォルダへコピーしました`);
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
  const connected = state.store.kind === "folder";
  const pending = !!state.pendingDir;

  let status;
  if (!FS_SUPPORTED) {
    status = "このブラウザはフォルダ保存（File System Access API）に対応していません。"
      + "Mac の Chrome / Edge で開くと iCloud Drive のフォルダに保存できます。"
      + "メモは現在このブラウザ内に保存されています。"
      + "※Safari は 7 日間アクセスがないとブラウザ内データを削除することがあるため、エクスポートで控えを残せます。";
  } else if (connected) {
    const name = FolderStore.dir && FolderStore.dir.name;
    status = `フォルダ${name ? `「${name}」` : ""}と接続中。メモは 1 件 = 1 つの .md ファイルとして保存され、`
      + "iCloud Drive 内のフォルダなら Apple が自動同期します。iPhone からはファイル.app で読めます。";
  } else if (pending) {
    status = `前回のフォルダ「${state.pendingDir.name}」への再接続待ちです。`
      + "ブラウザのセキュリティ上、再訪時はワンクリックの再許可が必要な場合があります。";
  } else {
    status = "iCloud Drive 内のフォルダを選ぶと、メモが .md ファイルとして保存され、Apple が自動同期します。"
      + "未接続の間はこのブラウザ内（localStorage）に保存されます。";
  }
  els.settingsStatus.textContent = status;

  els.btnChooseFolder.disabled = !FS_SUPPORTED;
  els.btnChooseFolder.textContent = pending ? "前回のフォルダに再接続"
    : connected ? "別のフォルダに変更…"
    : "保存先フォルダを選択…";
  els.btnDisconnect.hidden = !connected;
  els.btnMigrate.hidden = !(connected && LocalStore._read().length > 0);
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
    else openSettings();
  });
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

  window.addEventListener("focus", refreshFromDisk);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSave();
    else refreshFromDisk();
  });
  window.addEventListener("beforeunload", () => {
    if (state.dirty) saveNow();
  });
}

async function init() {
  bindEvents();

  // テスト用フック: ?opfs で OPFS ルートを保存先にする（picker はヘッドレスで操作不能のため）
  if (new URLSearchParams(location.search).has("opfs")) {
    const dir = await navigator.storage.getDirectory();
    await enterFolderMode(dir);
    return;
  }

  if (FS_SUPPORTED) {
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
        enterLocalMode(`フォルダ再接続が必要（クリック）`);
        return;
      }
    } catch (err) {
      console.error("handle restore failed:", err);
    }
  }
  enterLocalMode();
}

init();
