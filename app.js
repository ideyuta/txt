/* ───────────────────────────────────────────
   txt。 — iCloud (CloudKit JS) + localStorage メモ帳
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
  cfgContainer: $("cfg-container"),
  cfgToken: $("cfg-token"),
  cfgEnv: $("cfg-env"),
  cfgSave: $("cfg-save"),
  cfgClear: $("cfg-clear"),
  authArea: $("auth-area"),
  authUser: $("auth-user"),
  btnMigrate: $("btn-migrate"),
  toast: $("toast"),
};

const CONFIG_KEY = "txt.ck.config";
const NOTES_KEY = "txt.notes.v1";

/* ───────── ローカル保存 ───────── */

const LocalStore = {
  kind: "local",
  _read() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; }
    catch { return []; }
  },
  _write(notes) { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); },
  async list() { return this._read(); },
  async save(note) {
    const notes = this._read();
    const i = notes.findIndex((n) => n.id === note.id);
    if (i >= 0) notes[i] = note; else notes.unshift(note);
    this._write(notes);
    return note;
  },
  async remove(id) { this._write(this._read().filter((n) => n.id !== id)); },
};

/* ───────── iCloud (CloudKit) 保存 ───────── */

const CloudStore = {
  kind: "cloud",
  db: null,
  async list() {
    let query = { recordType: "Note" };
    let options = { resultsLimit: 200 };
    const records = [];
    let response = await this.db.performQuery(query, options);
    for (let page = 0; page < 10; page++) {
      if (response.hasErrors) throw response.errors[0];
      records.push(...response.records);
      if (!response.moreComing) break;
      response = await this.db.performQuery(response);
    }
    return records.map(recordToNote).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async save(note) {
    const record = {
      recordType: "Note",
      fields: {
        title: { value: note.title },
        body: { value: note.body },
        updatedAt: { value: note.updatedAt },
      },
    };
    if (!note.id.startsWith("l_")) {
      record.recordName = note.id;
      if (note.changeTag) record.recordChangeTag = note.changeTag;
    }
    let response = await this.db.saveRecords([record]);
    if (response.hasErrors) {
      const err = response.errors[0];
      // 競合（別端末が先に保存）→ 最新タグを取り直して上書き保存
      if (err.ckErrorCode === "CONFLICT" && err.serverErrorCode !== "NOT_FOUND") {
        const latest = await this.db.fetchRecords([record.recordName]);
        if (!latest.hasErrors && latest.records[0]) {
          record.recordChangeTag = latest.records[0].recordChangeTag;
          response = await this.db.saveRecords([record]);
          if (response.hasErrors) throw response.errors[0];
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    return recordToNote(response.records[0]);
  },
  async remove(id) {
    const response = await this.db.deleteRecords([id]);
    if (response.hasErrors) throw response.errors[0];
  },
};

function recordToNote(record) {
  return {
    id: record.recordName,
    title: record.fields.title ? record.fields.title.value : "",
    body: record.fields.body ? record.fields.body.value : "",
    updatedAt: record.fields.updatedAt
      ? record.fields.updatedAt.value
      : (record.modified ? record.modified.timestamp : Date.now()),
    changeTag: record.recordChangeTag,
  };
}

/* ───────── 状態 ───────── */

const state = {
  store: LocalStore,
  notes: [],
  currentId: null,
  query: "",
  dirty: false,
  saveTimer: null,
  saving: Promise.resolve(),
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
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
}

function currentNote() {
  return state.notes.find((n) => n.id === state.currentId) || null;
}

/* ───────── 描画 ───────── */

function renderList() {
  const q = state.query.trim().toLowerCase();
  const filtered = q
    ? state.notes.filter((n) =>
        (n.title + "\n" + n.body).toLowerCase().includes(q))
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
    if (!note.id.startsWith("l_") || state.store.kind === "local") {
      await state.store.remove(note.id);
    }
    state.notes = state.notes.filter((n) => n.id !== note.id);
    state.currentId = null;
    renderList();
    renderEditor();
    toast("メモを削除しました");
  } catch (err) {
    console.error(err);
    toast("削除に失敗しました", true);
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
      // iCloud 新規保存時はサーバ発行の ID / changeTag を反映
      if (saved.id !== note.id) {
        if (state.currentId === note.id) state.currentId = saved.id;
        note.id = saved.id;
      }
      note.changeTag = saved.changeTag;
      setSaveState("saved", state.store.kind === "cloud" ? "iCloud に保存済み" : "このブラウザに保存済み");
      renderList();
    } catch (err) {
      console.error("save failed:", err);
      state.dirty = true;
      setSaveState("error", "保存に失敗しました");
      toast(ckErrorMessage(err, "保存に失敗しました"), true);
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
    toast(ckErrorMessage(err, "メモ一覧の取得に失敗しました"), true);
  }
}

/* ───────── CloudKit 連携 ───────── */

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); }
  catch { return null; }
}

function ckErrorMessage(err, fallback) {
  if (err && err.ckErrorCode) {
    const map = {
      AUTHENTICATION_REQUIRED: "iCloud へのサインインが必要です（設定から）",
      AUTHENTICATION_FAILED: "iCloud 認証に失敗しました。トークンを確認してください",
      QUOTA_EXCEEDED: "iCloud の容量が不足しています",
      NETWORK_ERROR: "ネットワークに接続できません",
      THROTTLED: "アクセスが集中しています。少し待って再試行してください",
      BAD_REQUEST: "CloudKit のスキーマ設定を確認してください（README 参照）",
    };
    return map[err.ckErrorCode] || `${fallback}（${err.ckErrorCode}）`;
  }
  return fallback;
}

let ckContainer = null;

function loadCloudKitScript() {
  return new Promise((resolve, reject) => {
    if (window.CloudKit) return resolve();
    window.addEventListener("cloudkitloaded", () => resolve(), { once: true });
    const script = document.createElement("script");
    script.src = "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
    script.async = true;
    script.onerror = () => reject(new Error("CloudKit JS の読み込みに失敗しました"));
    document.head.appendChild(script);
  });
}

async function connectCloudKit(config) {
  setSyncStatus("pending", "iCloud に接続中…");
  await loadCloudKitScript();

  CloudKit.configure({
    locale: "ja-jp",
    containers: [{
      containerIdentifier: config.container,
      apiTokenAuth: {
        apiToken: config.token,
        persist: true,
        signInButton: { id: "apple-sign-in-button", theme: "black" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" },
      },
      environment: config.env || "development",
    }],
  });

  ckContainer = CloudKit.getDefaultContainer();
  els.authArea.hidden = false;

  const userIdentity = await ckContainer.setUpAuth();
  if (userIdentity) {
    await enterCloudMode(userIdentity);
  } else {
    enterLocalMode("iCloud 未サインイン");
  }
  watchAuth();
}

function watchAuth() {
  ckContainer.whenUserSignsIn().then(async (userIdentity) => {
    await enterCloudMode(userIdentity);
    watchAuth();
  }).catch(() => watchAuth());
  ckContainer.whenUserSignsOut().then(() => {
    enterLocalMode("iCloud からサインアウト中");
    watchAuth();
  }).catch(() => {});
}

async function enterCloudMode(userIdentity) {
  CloudStore.db = ckContainer.privateCloudDatabase;
  state.store = CloudStore;
  state.currentId = null;
  const name = userIdentity && userIdentity.nameComponents
    ? `${userIdentity.nameComponents.familyName || ""} ${userIdentity.nameComponents.givenName || ""}`.trim()
    : "";
  els.authUser.textContent = name ? `${name} としてサインイン中` : "サインイン中";
  setSyncStatus("cloud", "iCloud と同期中");
  updateMigrateButton();
  await reloadNotes();
}

function enterLocalMode(label) {
  state.store = LocalStore;
  state.currentId = null;
  els.authUser.textContent = "";
  setSyncStatus("", label || "ローカル保存");
  updateMigrateButton();
  reloadNotes();
}

function updateMigrateButton() {
  const hasLocal = LocalStore._read().length > 0;
  els.btnMigrate.hidden = !(state.store.kind === "cloud" && hasLocal);
}

async function migrateLocalNotes() {
  const localNotes = LocalStore._read();
  if (localNotes.length === 0) return;
  if (!confirm(`このブラウザに保存された ${localNotes.length} 件のメモを iCloud にコピーします。よろしいですか？`)) return;

  els.btnMigrate.disabled = true;
  let ok = 0;
  try {
    for (const note of localNotes) {
      await CloudStore.save({ ...note, id: "l_migrate" });
      ok++;
    }
    localStorage.removeItem(NOTES_KEY);
    toast(`${ok} 件のメモを iCloud にコピーしました`);
    updateMigrateButton();
    await reloadNotes();
  } catch (err) {
    console.error(err);
    toast(`${ok} 件コピー後に失敗しました。再度お試しください`, true);
  } finally {
    els.btnMigrate.disabled = false;
  }
}

/* ───────── 設定モーダル ───────── */

function openSettings() {
  const config = loadConfig() || {};
  els.cfgContainer.value = config.container || "";
  els.cfgToken.value = config.token || "";
  els.cfgEnv.value = config.env || "development";
  els.dialog.showModal();
}

function saveSettings() {
  const config = {
    container: els.cfgContainer.value.trim(),
    token: els.cfgToken.value.trim(),
    env: els.cfgEnv.value,
  };
  if (!config.container || !config.token) {
    toast("コンテナ ID と API トークンを入力してください", true);
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  toast("設定を保存しました。iCloud に接続します…");
  // CloudKit.configure は再構成できないためリロードで反映
  setTimeout(() => location.reload(), 600);
}

function clearSettings() {
  if (!confirm("iCloud 接続設定を消去しますか？（メモ自体は消えません）")) return;
  localStorage.removeItem(CONFIG_KEY);
  location.reload();
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
  els.syncChip.addEventListener("click", openSettings);
  els.cfgSave.addEventListener("click", saveSettings);
  els.cfgClear.addEventListener("click", clearSettings);
  els.btnMigrate.addEventListener("click", migrateLocalNotes);

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

  window.addEventListener("beforeunload", () => {
    if (state.dirty) saveNow();
  });
}

async function init() {
  bindEvents();
  const config = loadConfig();
  if (config && config.container && config.token) {
    try {
      await connectCloudKit(config);
    } catch (err) {
      console.error("CloudKit init failed:", err);
      setSyncStatus("error", "iCloud 接続エラー");
      toast(ckErrorMessage(err, "iCloud に接続できませんでした。ローカル保存に切り替えます"), true);
      enterLocalMode("iCloud 接続エラー（ローカル保存）");
    }
  } else {
    enterLocalMode();
  }
}

init();
