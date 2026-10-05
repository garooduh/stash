const $ = (id) => document.getElementById(id);
let folder = "";
let currentItems = [];
let searchTimer;
let requestVersion = 0;
let actionCallback = null;
const uploadJobs = [];
let uploadBusy = false;

function savedSetting(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function rememberSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be disabled. */ }
}
function setTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  document.querySelectorAll(".theme-select").forEach((select) => { select.value = theme; });
  rememberSetting("stash-theme", theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#16131d" : "#f7f5fb";
}
const initialTheme = savedSetting("stash-theme", "system");
setTheme(["system", "light", "dark"].includes(initialTheme) ? initialTheme : "system");
document.querySelectorAll(".theme-select").forEach((select) => select.addEventListener("change", () => setTheme(select.value)));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (savedSetting("stash-theme", "system") === "system") setTheme("system");
});

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== "GET") headers["X-Stash-CSRF"] = "1";
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  if (response.status === 401) {
    if (url === "/api/auth/login") throw new Error("Неверное имя пользователя или пароль");
    showLogin(); throw new Error("Требуется вход");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(typeof body.detail === "string" ? body.detail : `Ошибка ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function showLogin() {
  $("login-view").hidden = false;
  $("app-view").hidden = true;
  setSidebarOpen(false);
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
}
function showApp() { $("login-view").hidden = true; $("app-view").hidden = false; processUploads(); }
function setSidebarOpen(open) {
  $("sidebar").classList.toggle("is-open", open);
  $("sidebar-backdrop").hidden = !open;
  $("sidebar-open").setAttribute("aria-expanded", String(open));
  $("sidebar").inert = !open && matchMedia("(max-width: 1000px)").matches;
}
function notice(message, isError = false) {
  const box = $("notice");
  box.textContent = message; box.classList.toggle("error", isError); box.hidden = false;
  clearTimeout(box.timer); box.timer = setTimeout(() => { box.hidden = true; }, 6000);
}
function formatBytes(value) {
  if (value < 1024) return `${value} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"]; let index = -1;
  do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}
function dateLabel(value) {
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}
function joinPath(name) { return folder ? `${folder}/${name}` : name; }
function makeButton(label, title, action) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = label; button.title = title;
  button.setAttribute("aria-label", title); button.addEventListener("click", action);
  return button;
}
function renderBreadcrumbs() {
  const nav = $("breadcrumbs"); nav.replaceChildren();
  if ($("search-input").value.trim()) {
    nav.append(makeButton("Мои файлы", "Корневая папка", () => openFolder("")));
    const sep = document.createElement("span"); sep.className = "separator"; sep.textContent = "/";
    const current = document.createElement("span"); current.className = "current"; current.textContent = "Поиск";
    nav.append(sep, current); return;
  }
  const parts = folder ? folder.split("/") : [];
  nav.append(makeButton("Мои файлы", "Корневая папка", () => openFolder("")));
  parts.forEach((part, index) => {
    const sep = document.createElement("span"); sep.className = "separator"; sep.textContent = "/"; nav.append(sep);
    nav.append(makeButton(part, part, () => openFolder(parts.slice(0, index + 1).join("/"))));
  });
}
function fileKind(item) {
  if (item.is_dir) return "folder";
  const extension = item.name.split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif"].includes(extension)) return "image";
  if (["mp3", "wav", "flac", "ogg", "m4a"].includes(extension)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(extension)) return "video";
  if (["zip", "tar", "gz", "7z", "rar"].includes(extension)) return "archive";
  return "document";
}
const iconPaths = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  audio: '<path d="M9 18V6l11-2v12M9 10l11-2"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  archive: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 8h16M10 3v10m4-10v10m-4 3h4v3h-4z"/>',
  document: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 15h8M8 18h5"/>',
};
function fileIcon(item) {
  const kind = fileKind(item);
  const icon = document.createElement("span"); icon.className = `file-icon ${kind}`;
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[kind]}</svg>`;
  return icon;
}
function menuAction(menu, label, action, danger = false) {
  const button = makeButton(label, label, () => { menu.open = false; action(); });
  if (danger) button.className = "danger";
  return button;
}
function renderEmpty(list, reason) {
  const empty = document.createElement("div"); empty.className = "empty";
  empty.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths.folder}</svg>`;
  const title = document.createElement("strong");
  const hint = document.createElement("span");
  if (reason === "search") {
    title.textContent = "Ничего не найдено"; hint.textContent = "Попробуйте другой запрос";
  } else if (reason === "filter") {
    title.textContent = "Таких файлов здесь нет"; hint.textContent = "Измените фильтр, чтобы увидеть остальные файлы";
  } else {
    title.textContent = "Папка пуста"; hint.textContent = "Загрузите файлы или создайте папку";
  }
  empty.append(title, hint);
  if (reason !== "filter") {
    const button = makeButton(reason === "search" ? "Очистить поиск" : "Загрузить", reason === "search" ? "Очистить поиск" : "Загрузить файлы или папку", () => {
      if (reason === "search") clearSearch(); else $("upload-button").click();
    });
    button.className = "button primary"; empty.append(button);
  }
  list.append(empty);
}
function renderItems(items) {
  const list = $("file-list"); list.replaceChildren();
  if (!items.length) {
    renderEmpty(list, currentItems.length ? "filter" : $("search-input").value.trim() ? "search" : "folder");
    return;
  }
  for (const item of items) {
    const row = document.createElement("div"); row.className = "file-row";
    const name = makeButton("", item.is_dir ? `Открыть папку ${item.name}` : `Скачать ${item.name}`, () => item.is_dir ? openFolder(item.path) : download(item.path));
    name.className = "file-name";
    const text = document.createElement("span"); text.className = "file-name-text"; text.textContent = item.name;
    name.append(fileIcon(item), text);
    const size = document.createElement("div"); size.className = "file-meta size"; size.textContent = item.is_dir ? "—" : formatBytes(item.size);
    const modified = document.createElement("div"); modified.className = "file-meta modified"; modified.textContent = dateLabel(item.modified_at);
    const mobileMeta = document.createElement("div"); mobileMeta.className = "file-meta mobile-meta";
    mobileMeta.textContent = item.is_dir ? dateLabel(item.modified_at) : `${formatBytes(item.size)} · ${dateLabel(item.modified_at)}`;
    const menu = document.createElement("details"); menu.className = "row-menu";
    const summary = document.createElement("summary"); summary.textContent = "⋮"; summary.title = `Действия: ${item.name}`;
    summary.setAttribute("aria-label", `Действия: ${item.name}`);
    const menuItems = document.createElement("div"); menuItems.className = "row-menu-items";
    menuItems.append(menuAction(menu, item.is_dir ? "Открыть" : "Скачать", () => item.is_dir ? openFolder(item.path) : download(item.path)));
    if (item.is_dir) menuItems.append(menuAction(menu, "Скачать ZIP", () => downloadFolder(item.path)));
    menuItems.append(menuAction(menu, "Переименовать", () => rename(item)));
    menuItems.append(menuAction(menu, "Переместить", () => move(item)));
    const separator = document.createElement("div"); separator.className = "menu-separator"; menuItems.append(separator);
    menuItems.append(menuAction(menu, "Удалить", () => remove(item), true));
    menu.append(summary, menuItems);
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      document.querySelectorAll(".row-menu[open]").forEach((other) => { if (other !== menu) other.open = false; });
      const roomBelow = window.innerHeight - menu.getBoundingClientRect().bottom;
      menuItems.style.top = roomBelow < 200 ? "auto" : "39px";
      menuItems.style.bottom = roomBelow < 200 ? "39px" : "auto";
    });
    row.append(name, size, modified, mobileMeta, menu); list.append(row);
  }
}
function displayItems() {
  const type = $("type-filter").value;
  const sort = $("sort-select").value;
  const items = currentItems.filter((item) => type === "all" || item.is_dir === (type === "folder"));
  items.sort((a, b) => {
    if (sort === "modified") return new Date(b.modified_at) - new Date(a.modified_at) || a.name.localeCompare(b.name, "ru");
    if (sort === "size") return b.size - a.size || a.name.localeCompare(b.name, "ru");
    return Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name, "ru");
  });
  renderItems(items);
  const query = $("search-input").value.trim();
  $("page-title").textContent = query ? "Результаты поиска" : folder ? folder.split("/").at(-1) : "Мои файлы";
  const count = currentItems.length;
  const form = count % 10 === 1 && count % 100 !== 11 ? "элемент" : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? "элемента" : "элементов";
  $("page-subtitle").textContent = query ? `Найдено: ${count}` : `${count} ${form}`;
}
function setView(mode) {
  $("file-list").classList.toggle("grid-view", mode === "grid");
  $("list-view-button").setAttribute("aria-pressed", String(mode === "list"));
  $("grid-view-button").setAttribute("aria-pressed", String(mode === "grid"));
  rememberSetting("stash-view", mode);
}
function renderStorage(storage) {
  const percent = storage.total > 0 ? Math.min(100, Math.round(storage.used / storage.total * 100)) : 0;
  $("storage-progress").style.width = `${percent}%`;
  $("storage-percent").textContent = `${percent}%`;
  $("storage-summary").textContent = `${formatBytes(storage.used)} из ${formatBytes(storage.total)}`;
  $("storage-summary-inline").textContent = `${formatBytes(storage.available)} свободно`;
}
function folderUrl(path) { return path ? `/?path=${encodeURIComponent(path)}` : "/"; }
function initializeFolderHistory(path) {
  if (history.state?.stash) {
    history.replaceState({ stash: true, path }, "", folderUrl(path));
    return;
  }
  history.replaceState({ stash: true, path: "" }, "", folderUrl(""));
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    history.pushState({ stash: true, path: current }, "", folderUrl(current));
  }
}
function clearSearchState() {
  clearTimeout(searchTimer); requestVersion++;
  $("search-input").value = ""; $("search-clear").hidden = true;
}
async function refresh() {
  const version = ++requestVersion;
  const query = $("search-input").value.trim();
  const url = query ? `/api/files/search?q=${encodeURIComponent(query)}` : `/api/files?path=${encodeURIComponent(folder)}`;
  try {
    const [files, storage] = await Promise.all([api(url), api("/api/storage")]);
    if (version !== requestVersion) return;
    currentItems = files.items; renderBreadcrumbs(); displayItems(); renderStorage(storage);
  } catch (error) { if (version === requestVersion) notice(error.message, true); }
}
function openFolder(path, { replace = false } = {}) {
  const pathChanged = path !== folder;
  folder = path; clearSearchState();
  const method = replace || !pathChanged ? "replaceState" : "pushState";
  history[method]({ stash: true, path }, "", folderUrl(path));
  setSidebarOpen(false); refresh();
}
function clearSearch() { clearSearchState(); refresh(); }
function download(path) { location.href = `/api/files/download?path=${encodeURIComponent(path)}`; }
function downloadFolder(path) { location.href = `/api/folders/download?path=${encodeURIComponent(path)}`; }

function openActionDialog({ title, description, fieldLabel = "", value = "", submitLabel, danger = false, onConfirm }) {
  $("action-title").textContent = title;
  $("action-description").textContent = description;
  $("action-field-label").textContent = fieldLabel;
  $("action-field-label").hidden = !fieldLabel;
  $("action-input").hidden = !fieldLabel;
  $("action-input").required = Boolean(fieldLabel);
  $("action-input").value = value;
  $("action-error").textContent = "";
  $("action-submit").textContent = submitLabel;
  $("action-submit").className = `button ${danger ? "danger" : "primary"}`;
  $("action-submit").disabled = false;
  actionCallback = onConfirm;
  $("action-dialog").showModal();
  if (fieldLabel) $("action-input").focus(); else $("action-submit").focus();
}
function rename(item) {
  openActionDialog({ title: "Переименовать", description: `Новое имя для «${item.name}»`, fieldLabel: "Имя", value: item.name, submitLabel: "Сохранить", onConfirm: async (name) => {
    if (name !== item.name) await api("/api/files/rename", { method: "PATCH", body: JSON.stringify({ path: item.path, name }) });
    await refresh();
  } });
}
function move(item) {
  openActionDialog({ title: "Переместить", description: "Укажите новый путь от корня хранилища, включая имя файла или папки.", fieldLabel: "Новый путь", value: item.path, submitLabel: "Переместить", onConfirm: async (destination) => {
    if (destination !== item.path) await api("/api/files/move", { method: "POST", body: JSON.stringify({ path: item.path, destination }) });
    await refresh();
  } });
}
function remove(item) {
  openActionDialog({ title: "Удалить файл?", description: `«${item.name}»${item.is_dir ? " и всё содержимое папки" : ""} будут удалены без возможности восстановления.`, submitLabel: "Удалить", danger: true, onConfirm: async () => {
    await api(`/api/files?path=${encodeURIComponent(item.path)}`, { method: "DELETE" }); await refresh();
  } });
  if (item.is_dir) $("action-title").textContent = "Удалить папку?";
}
function createFolder() {
  openActionDialog({ title: "Новая папка", description: "Папка появится в текущем расположении.", fieldLabel: "Название папки", submitLabel: "Создать", onConfirm: async (name) => {
    await api("/api/folders", { method: "POST", body: JSON.stringify({ path: joinPath(name) }) }); await refresh();
  } });
}

function setUploadMenuOpen(open) {
  $("upload-menu-items").hidden = !open;
  $("upload-button").setAttribute("aria-expanded", String(open));
}

function renderUploads() {
  const list = $("upload-list"); list.replaceChildren();
  $("upload-panel").hidden = uploadJobs.length === 0;
  $("upload-dismiss").hidden = !uploadJobs.some((job) => ["success", "cancelled"].includes(job.state));
  const relevant = uploadJobs.filter((job) => job.state !== "cancelled");
  const totalWeight = relevant.reduce((sum, job) => sum + Math.max(job.file.size, 1), 0);
  const loadedWeight = relevant.reduce((sum, job) => {
    if (job.state === "success") return sum + Math.max(job.file.size, 1);
    if (job.state === "uploading") return sum + Math.max(job.file.size, 1) * job.progress / 100;
    return sum;
  }, 0);
  const percent = totalWeight ? Math.round(loadedWeight / totalWeight * 100) : 0;
  const completed = relevant.filter((job) => job.state === "success").length;
  const failed = relevant.filter((job) => job.state === "error").length;
  $("upload-summary").textContent = `${completed} из ${relevant.length} файлов загружено${failed ? ` · ошибок: ${failed}` : ""}`;
  $("upload-overall-progress").setAttribute("aria-valuenow", String(percent));
  $("upload-overall-fill").style.width = `${percent}%`;
  const visible = new Set([
    ...uploadJobs.filter((job) => ["preparing", "uploading", "error"].includes(job.state)),
    ...uploadJobs.filter((job) => job.state === "queued").slice(0, 25),
    ...uploadJobs.filter((job) => ["success", "cancelled"].includes(job.state)).slice(-8),
  ]);
  for (const job of uploadJobs) {
    if (!visible.has(job)) continue;
    const row = document.createElement("div"); row.className = "upload-item";
    const name = document.createElement("span"); name.className = "upload-name"; name.textContent = job.relativePath; name.title = job.relativePath;
    const status = document.createElement("span"); status.className = "upload-status";
    const labels = { queued: "В очереди", preparing: "Создание папок", uploading: `${job.progress}%`, success: "Готово", error: "Ошибка", cancelled: "Отменено" };
    status.textContent = job.error || labels[job.state]; status.title = status.textContent;
    if (job.state === "success") status.classList.add("success");
    if (job.state === "error") status.classList.add("error");
    row.append(name, status);
    if (job.state === "uploading") {
      const track = document.createElement("div"); track.className = "progress-track";
      track.setAttribute("role", "progressbar"); track.setAttribute("aria-label", `Загрузка ${job.file.name}`);
      track.setAttribute("aria-valuenow", String(job.progress)); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
      const fill = document.createElement("div"); fill.className = "progress-fill"; fill.style.width = `${job.progress}%`; track.append(fill); row.append(track);
    }
    if (["queued", "preparing", "uploading", "error", "cancelled"].includes(job.state)) {
      const retry = job.state === "error" || job.state === "cancelled";
      const control = makeButton(retry ? "Повторить" : "Отменить", retry ? `Повторить ${job.relativePath}` : `Отменить ${job.relativePath}`, () => {
        if (retry) { job.state = "queued"; job.error = ""; job.progress = 0; job.cancelRequested = false; renderUploads(); processUploads(); }
        else if (job.state === "uploading") job.xhr.abort();
        else if (job.state === "preparing") { job.cancelRequested = true; status.textContent = "Отмена…"; }
        else { job.state = "cancelled"; renderUploads(); }
      });
      control.className = "upload-control"; row.append(control);
    }
    list.append(row);
  }
  if (uploadJobs.length > visible.size) {
    const more = document.createElement("div"); more.className = "upload-more";
    more.textContent = `Ещё ${uploadJobs.length - visible.size} файлов в очереди или завершено`;
    list.append(more);
  }
}
async function ensureUploadFolder(job) {
  let path = job.batch.baseFolder;
  if (!job.relativeFolder) return path;
  for (const part of job.relativeFolder.split("/")) {
    path = path ? `${path}/${part}` : part;
    if (job.batch.preparedFolders.has(path)) continue;
    try {
      await api("/api/folders", { method: "POST", body: JSON.stringify({ path }) });
    } catch (error) {
      if (error.status !== 409) throw error;
      // A name conflict is acceptable only when that path is an existing folder.
      await api(`/api/files?path=${encodeURIComponent(path)}`);
    }
    job.batch.preparedFolders.add(path);
  }
  return path;
}
let uploadsNeedRefresh = false;
function finishUpload(job, state, error = "") {
  job.state = state; job.error = error; job.xhr = null; uploadBusy = false;
  if (state === "success") uploadsNeedRefresh = true;
  renderUploads();
  if (state === "error" && error) notice(`${job.relativePath}: ${error}`, true);
  if (!uploadJobs.some((entry) => ["queued", "preparing", "uploading"].includes(entry.state)) && uploadsNeedRefresh) {
    uploadsNeedRefresh = false; refresh();
  }
  processUploads();
}
async function processUploads() {
  if (uploadBusy || $("app-view").hidden) return;
  const job = uploadJobs.find((entry) => entry.state === "queued");
  if (!job) return;
  uploadBusy = true; job.state = "preparing"; renderUploads();
  let targetFolder;
  try { targetFolder = await ensureUploadFolder(job); }
  catch (error) { finishUpload(job, "error", error.message); return; }
  if (job.cancelRequested) { finishUpload(job, "cancelled"); return; }
  job.state = "uploading"; renderUploads();
  const xhr = new XMLHttpRequest(); job.xhr = xhr;
  xhr.open("POST", "/api/files/upload"); xhr.withCredentials = true;
  xhr.setRequestHeader("X-Stash-CSRF", "1");
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) { job.progress = Math.round(event.loaded / event.total * 100); renderUploads(); }
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) { finishUpload(job, "success"); return; }
    if (xhr.status === 401) showLogin();
    let detail = `Ошибка ${xhr.status}`;
    try { detail = JSON.parse(xhr.responseText).detail || detail; } catch { /* Non-JSON response. */ }
    finishUpload(job, "error", detail);
  };
  xhr.onerror = () => finishUpload(job, "error", "Сетевая ошибка");
  xhr.onabort = () => finishUpload(job, "cancelled");
  const form = new FormData(); form.append("folder", targetFolder); form.append("file", job.file, job.filename);
  try { xhr.send(form); }
  catch (error) { finishUpload(job, "error", error.message); }
}
function enqueueUploadItems(items, fromFolder = false) {
  if (fromFolder && !items.length) {
    notice("Выбранная папка не содержит файлов. Пустую папку можно создать кнопкой «Новая папка».", true);
    return;
  }
  const batch = { baseFolder: folder, preparedFolders: new Set() };
  let invalid = 0;
  for (const item of items) {
    const file = item.file || item;
    const relativePath = item.relativePath || (fromFolder ? file.webkitRelativePath : file.name);
    const parts = relativePath?.split("/") || [];
    if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
      invalid++; continue;
    }
    uploadJobs.push({ file, batch, relativePath, filename: parts.at(-1), relativeFolder: parts.slice(0, -1).join("/"), state: "queued", progress: 0, error: "", xhr: null, cancelRequested: false });
  }
  if (invalid) notice(`Пропущено файлов с некорректным путём: ${invalid}`, true);
  renderUploads(); processUploads();
}

function enqueueFiles(files, fromFolder = false) {
  enqueueUploadItems(files, fromFolder);
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(entry) {
  const reader = entry.createReader();
  const entries = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(entries); return; }
      entries.push(...batch); readBatch();
    }, reject);
    readBatch();
  });
}

async function uploadItemsFromEntry(entry, parent = "") {
  const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) return [{ file: await entryFile(entry), relativePath }];
  if (!entry.isDirectory) return [];
  const children = await readDirectoryEntries(entry);
  const nested = await Promise.all(children.map((child) => uploadItemsFromEntry(child, relativePath)));
  return nested.flat();
}

async function droppedUploadItems(dataTransfer) {
  const transferItems = Array.from(dataTransfer.items || []).filter((item) => item.kind === "file");
  const fallbackFiles = Array.from(dataTransfer.files || []);
  // DataTransfer is only guaranteed to be readable while the drop event is being handled.
  // Capture every entry before the first asynchronous directory read.
  const entries = transferItems.map((item) => {
    const getEntry = item.getAsEntry || item.webkitGetAsEntry;
    return { entry: getEntry?.call(item), file: item.getAsFile() };
  });
  const collected = [];
  for (const { entry, file } of entries) {
    if (entry) collected.push(...await uploadItemsFromEntry(entry));
    else if (file) collected.push({ file, relativePath: file.name });
  }
  if (transferItems.length) return collected;
  return fallbackFiles.map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

async function loadTokens() {
  try {
    const data = await api("/api/webdav-tokens"); const list = $("token-list"); list.replaceChildren();
    if (!data.items.length) { const empty = document.createElement("div"); empty.className = "storage-caption"; empty.textContent = "Токенов пока нет"; list.append(empty); }
    for (const token of data.items) {
      const row = document.createElement("div"); row.className = "token-item";
      const title = document.createElement("span"); title.textContent = token.name;
      row.append(title, makeButton("Отозвать", `Отозвать ${token.name}`, () => {
        openActionDialog({ title: "Отозвать токен?", description: `Устройство «${token.name}» потеряет доступ по WebDAV.`, submitLabel: "Отозвать", danger: true, onConfirm: async () => {
          await api(`/api/webdav-tokens/${token.id}`, { method: "DELETE" }); await loadTokens();
        } });
      })); list.append(row);
    }
  } catch (error) { notice(error.message, true); }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("login-error").textContent = "";
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: $("username").value.trim(), password: $("password").value }) });
    $("password").value = ""; showApp(); openFolder("", { replace: true });
  } catch (error) { $("login-error").textContent = error.message; }
});
$("logout-button").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST" }); } finally { showLogin(); } });
$("sidebar-open").addEventListener("click", () => setSidebarOpen(true));
$("sidebar-close").addEventListener("click", () => setSidebarOpen(false));
$("sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
matchMedia("(max-width: 1000px)").addEventListener("change", () => setSidebarOpen(false));
setSidebarOpen(false);
$("files-nav").addEventListener("click", () => openFolder(""));
$("new-folder-button").addEventListener("click", createFolder);
$("upload-button").addEventListener("click", () => {
  setUploadMenuOpen($("upload-button").getAttribute("aria-expanded") !== "true");
});
$("upload-files-option").addEventListener("click", () => { setUploadMenuOpen(false); $("upload-input").click(); });
$("upload-input").addEventListener("change", (event) => { enqueueFiles(Array.from(event.target.files)); event.target.value = ""; });
$("upload-folder-option").addEventListener("click", () => { setUploadMenuOpen(false); $("upload-folder-input").click(); });
$("upload-folder-input").addEventListener("change", (event) => {
  enqueueFiles(Array.from(event.target.files), true); event.target.value = "";
});
$("upload-dismiss").addEventListener("click", () => {
  for (let index = uploadJobs.length - 1; index >= 0; index--) {
    if (["success", "cancelled"].includes(uploadJobs[index].state)) uploadJobs.splice(index, 1);
  }
  renderUploads();
});
$("search-input").addEventListener("input", (event) => {
  clearTimeout(searchTimer); requestVersion++; $("search-clear").hidden = !event.target.value;
  searchTimer = setTimeout(refresh, 220);
});
$("search-clear").addEventListener("click", clearSearch);
$("type-filter").addEventListener("change", displayItems);
$("sort-select").addEventListener("change", displayItems);
$("list-view-button").addEventListener("click", () => setView("list"));
$("grid-view-button").addEventListener("click", () => setView("grid"));
setView(savedSetting("stash-view", "list") === "grid" ? "grid" : "list");
document.addEventListener("click", (event) => {
  if (!event.target.closest("#upload-menu")) setUploadMenuOpen(false);
  if (!event.target.closest(".row-menu")) document.querySelectorAll(".row-menu[open]").forEach((menu) => { menu.open = false; });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSidebarOpen(false);
    setUploadMenuOpen(false);
    document.querySelectorAll(".row-menu[open]").forEach((menu) => { menu.open = false; });
  }
});
window.addEventListener("popstate", () => {
  folder = new URLSearchParams(location.search).get("path") || "";
  clearSearchState(); setSidebarOpen(false);
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  if (!$("app-view").hidden) refresh();
});
$("action-close").addEventListener("click", () => $("action-dialog").close());
$("action-cancel").addEventListener("click", () => $("action-dialog").close());
$("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!actionCallback) return;
  const value = $("action-input").value.trim();
  if ($("action-input").required && !value) { $("action-error").textContent = "Введите значение"; return; }
  $("action-submit").disabled = true; $("action-error").textContent = "";
  try { await actionCallback(value); $("action-dialog").close(); }
  catch (error) { $("action-error").textContent = error.message; }
  finally { $("action-submit").disabled = false; }
});
$("settings-button").addEventListener("click", () => {
  setSidebarOpen(false); $("dav-url").textContent = `${location.origin}/dav/`;
  $("new-token").hidden = true; $("copy-token").textContent = "Копировать";
  $("settings-dialog").showModal(); loadTokens();
});
$("close-settings").addEventListener("click", () => $("settings-dialog").close());
$("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/webdav-tokens", { method: "POST", body: JSON.stringify({ name: $("token-name").value }) });
    $("token-name").value = ""; $("token-value").textContent = data.token;
    $("new-token").hidden = false; await loadTokens();
  } catch (error) { notice(error.message, true); }
});
$("copy-token").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("token-value").textContent); $("copy-token").textContent = "Скопировано"; }
  catch { notice("Не удалось скопировать токен", true); }
});
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if ($("app-view").hidden || !Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault(); dragDepth++; $("drop-overlay").hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!$("drop-overlay").hidden) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-overlay").hidden = true; } });
document.addEventListener("drop", async (event) => {
  if ($("drop-overlay").hidden) return;
  event.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true;
  try {
    const items = await droppedUploadItems(event.dataTransfer);
    if (!items.length) {
      notice("В перетащенных папках нет файлов.", true);
      return;
    }
    enqueueUploadItems(items);
  } catch (error) {
    notice(`Не удалось прочитать перетащенную папку: ${error.message}`, true);
  }
});
(async () => {
  try {
    await api("/api/auth/me"); showApp();
    folder = new URLSearchParams(location.search).get("path") || "";
    initializeFolderHistory(folder);
    await refresh();
  } catch { showLogin(); }
})();
