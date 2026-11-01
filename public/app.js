const $ = id => document.getElementById(id);
const state = { config: null, photos: [], index: 0, scanning: false, scanVersion: 0, sourcePath: '', targetPath: '', destinationRoot: '', destinationAvailable: false, targetLoading: false, targetChanging: false, saving: false, copying: false, saved: new Map(), savedCount: 0, folderVersion: 0, targetVersion: 0, imageVersion: 0, imageController: null, imageURL: null, browseVersion: 0, browsePath: '', browseKind: 'source', selecting: false, toastTimer: null };

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json', 'X-Photo-Token': state.config?.csrfToken ?? '' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
  return result;
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
const leaf = value => value.split('/').filter(Boolean).at(-1) || '/';
const imagePath = (photo, kind = 'preview') => `/api/photo/${photo.id}?size=${kind}`;
const savedKey = (photo, target = state.targetPath) => `${photo.id}:${target}`;
const sizeLabel = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 4500);
}
function setViewerState(title, description, action = false) {
  $('viewerState').hidden = false; $('stateTitle').textContent = title; $('stateDescription').textContent = description; $('stateAction').hidden = !action;
  $('photo').hidden = true; $('imageLoading').hidden = true; $('retryPreview').hidden = true; $('viewer').setAttribute('aria-busy', 'false');
}
function updateControls() {
  const photo = state.photos[state.index];
  const saved = photo && state.saved.has(savedKey(photo));
  $('previous').disabled = state.scanning || !photo || state.index === 0;
  $('next').disabled = state.scanning || !photo || state.index >= state.photos.length - 1;
  $('copy').disabled = state.scanning || !photo || state.copying;
  $('copyLabel').textContent = state.copying ? '复制中…' : '复制照片';
  $('copy').setAttribute('aria-busy', String(state.copying));
  $('save').disabled = state.scanning || !photo || !state.destinationAvailable || state.targetLoading || state.targetChanging || state.saving;
  $('newFolder').disabled = !state.destinationAvailable || state.targetLoading || state.targetChanging;
  $('retryTarget').disabled = state.targetLoading || state.targetChanging;
  $('saveLabel').textContent = state.saving ? '正在保存…' : saved ? '已保存' : '保存原图';
  $('savedBadge').hidden = !saved;
  $('fullscreen').disabled = !photo;
  $('rescan').disabled = state.scanning;
  $('savedCount').textContent = state.savedCount;
}

async function scan(sourcePath) {
  const version = ++state.scanVersion;
  const previousId = state.sourcePath === sourcePath ? state.photos[state.index]?.id : null;
  state.sourcePath = sourcePath;
  state.scanning = true; state.imageController?.abort(); ++state.imageVersion;
  $('sourcePath').textContent = sourcePath; $('sourcePath').title = sourcePath;
  $('sourceName').textContent = sourcePath.includes('NIKON') ? 'NIKON Z5_2' : leaf(sourcePath);
  $('photoCount').textContent = '扫描中'; $('position').textContent = '— / —';
  $('filmstrip').replaceChildren(); $('fileName').textContent = '正在扫描'; $('fileMeta').textContent = '';
  setViewerState('正在读取照片', '正在扫描文件夹和子文件夹'); updateControls();
  try {
    const result = await post('/api/photos', { path: sourcePath });
    if (version !== state.scanVersion) return;
    state.sourcePath = result.path; state.photos = result.photos; state.index = Math.max(0, state.photos.findIndex(p => p.id === previousId));
    $('sourcePath').textContent = result.path; $('photoCount').textContent = `${result.total.toLocaleString()} 张`;
    $('scanNote').textContent = result.warnings.length ? `${result.warnings.length} 个文件无法读取` : '保留相机卡原图';
    state.scanning = false;
    if (result.total) showPhoto();
    else { setViewerState('这个目录里没有照片', '支持 JPG、PNG、WebP、TIFF、HEIC 和 AVIF，可选择其他来源。', true); $('fileName').textContent = '暂无照片'; updateControls(); }
    if (result.warnings.length) toast(result.warnings.slice(0, 2).join('；'), true);
  } catch (error) {
    if (version !== state.scanVersion) return;
    state.photos = []; state.scanning = false;
    $('photoCount').textContent = '无法读取'; $('fileName').textContent = '来源不可用';
    setViewerState('无法读取照片目录', error.message, true); updateControls();
  }
}

function showPhoto() {
  const photo = state.photos[state.index];
  if (!photo) return;
  $('position').textContent = `${(state.index + 1).toLocaleString()} / ${state.photos.length.toLocaleString()}`;
  $('fileName').textContent = photo.name;
  $('fileMeta').textContent = `${sizeLabel(photo.size)} · ${photo.relativePath.split('/').slice(0, -1).join('/') || '当前目录'}`;
  $('photoFormat').textContent = `${photo.name.split('.').at(-1).toUpperCase()} · ${sizeLabel(photo.size)}`;
  $('photo').alt = photo.name;
  updateControls(); renderFilmstrip(); loadPreview(photo);
}

async function loadPreview(photo) {
  const version = ++state.imageVersion;
  state.imageController?.abort(); state.imageController = new AbortController();
  $('viewerState').hidden = true; $('photo').hidden = true; $('imageLoading').hidden = false; $('retryPreview').hidden = true; $('viewer').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(imagePath(photo), { signal: state.imageController.signal });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
    const blob = await response.blob();
    if (version !== state.imageVersion) return;
    const objectURL = URL.createObjectURL(blob);
    const temporaryImage = new Image(); temporaryImage.src = objectURL;
    try { await temporaryImage.decode(); } catch { URL.revokeObjectURL(objectURL); throw new Error('这张照片无法生成预览，仍可保存原图。'); }
    if (version !== state.imageVersion) { URL.revokeObjectURL(objectURL); return; }
    if (state.imageURL) URL.revokeObjectURL(state.imageURL);
    state.imageURL = objectURL; $('photo').src = objectURL; $('photo').hidden = false; $('imageLoading').hidden = true; $('viewer').setAttribute('aria-busy', 'false');
    // Warm only immediate neighbours; never load all 3503 originals into the browser.
    for (const index of [state.index - 1, state.index + 1]) {
      if (state.photos[index]) fetch(imagePath(state.photos[index])).then(response => response.body?.cancel()).catch(() => {});
    }
  } catch (error) {
    if (error.name === 'AbortError' || version !== state.imageVersion) return;
    setViewerState('预览无法加载', error.message || '请确认相机卡仍已连接。'); $('retryPreview').hidden = false;
  }
}

function renderFilmstrip() {
  const start = Math.max(0, state.index - 7);
  const end = Math.min(state.photos.length, state.index + 8);
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index++) {
    const photo = state.photos[index];
    const button = document.createElement('button'); button.className = `thumbnail${index === state.index ? ' active' : ''}`;
    button.setAttribute('aria-label', `第 ${index + 1} 张，${photo.name}`); button.setAttribute('aria-current', index === state.index ? 'true' : 'false'); button.title = photo.name;
    const img = document.createElement('img'); img.src = imagePath(photo, 'thumb'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    button.append(img);
    if (state.saved.has(savedKey(photo))) { const badge = document.createElement('span'); badge.className = 'thumb-saved'; badge.textContent = '✓'; button.append(badge); }
    button.addEventListener('click', () => { state.index = index; showPhoto(); }); fragment.append(button);
  }
  $('filmstrip').replaceChildren(fragment);
  const active = $('filmstrip').querySelector('.active');
  if (active) $('filmstrip').scrollLeft = active.offsetLeft - $('filmstrip').offsetLeft - ($('filmstrip').clientWidth - active.clientWidth) / 2;
}

function navigate(delta) {
  if (state.scanning || !state.photos.length) return;
  const next = Math.min(Math.max(state.index + delta, 0), state.photos.length - 1);
  if (state.index !== next) { state.index = next; showPhoto(); }
}

function folderButton(folder, onClick) {
  const button = document.createElement('button'); button.className = 'folder-row'; button.title = folder.path;
  for (const value of ['▱', folder.name, '›']) { const span = document.createElement('span'); span.textContent = value; button.append(span); }
  button.addEventListener('click', () => onClick(folder.path)); return button;
}
function folderMessage(container, text) { const p = document.createElement('p'); p.className = 'folder-empty'; p.textContent = text; container.replaceChildren(p); }

function updateTargetDisplay() {
  $('targetName').textContent = leaf(state.targetPath); $('targetPath').textContent = state.targetPath; $('targetPath').title = state.targetPath;
  $('destinationLabel').textContent = state.destinationRoot.startsWith('/Volumes/nas/') ? `NAS · ${state.destinationRoot.slice('/Volumes/nas/'.length).replaceAll('/', ' / ')}` : '所选归档目录';
  $('destinationServer').textContent = state.targetPath.startsWith('/Volumes/nas/') ? '192.168.1.66' : '本机已挂载目录';
  $('parentFolder').disabled = state.targetPath === '/' || state.targetPath === state.destinationRoot;
  updateControls();
}

async function loadTarget() {
  const version = ++state.folderVersion;
  const target = state.targetPath;
  state.targetLoading = true; state.destinationAvailable = false; updateControls();
  $('folderError').hidden = true; $('retryTarget').hidden = true; folderMessage($('folders'), '正在读取文件夹…');
  try {
    const result = await api(`/api/target?path=${encodeURIComponent(target)}`);
    if (version !== state.folderVersion) return;
    state.destinationAvailable = true; $('nasStatus').classList.remove('offline'); $('nasStatus').title = '目录已连接';
    if (!result.folders.length) folderMessage($('folders'), '暂无子文件夹，可在此保存或新建');
    else $('folders').replaceChildren(...result.folders.map(folder => folderButton(folder, chooseTarget)));
  } catch (error) {
    if (version !== state.folderVersion) return;
    state.destinationAvailable = false; $('nasStatus').classList.add('offline'); $('nasStatus').title = '目录无法访问';
    $('folders').replaceChildren(); $('folderError').textContent = error.message; $('folderError').hidden = false;
    $('retryTarget').hidden = false;
  }
  state.targetLoading = false;
  updateTargetDisplay();
}

async function chooseTarget(target, root) {
  const version = ++state.targetVersion;
  state.targetChanging = true; updateControls();
  try {
    const settings = await post('/api/settings', { targetPath: target, ...(root ? { destinationRoot: root } : {}) });
    if (version !== state.targetVersion) return false;
    state.targetPath = settings.targetPath; state.destinationRoot = settings.destinationRoot;
    $('saveFeedback').textContent = ''; updateTargetDisplay(); renderFilmstrip(); await loadTarget();
    return true;
  } catch (error) { if (version === state.targetVersion) toast(error.message, true); return false; }
  finally { if (version === state.targetVersion) { state.targetChanging = false; updateControls(); } }
}

async function copyPhoto() {
  const photo = state.photos[state.index];
  if (!photo || state.scanning || state.copying) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined' || (ClipboardItem.supports && !ClipboardItem.supports('image/png'))) {
    toast('当前浏览器不支持复制照片，请使用新版 Chrome、Edge 或 Safari。', true);
    return;
  }
  state.copying = true; updateControls();
  try {
    const image = fetch(imagePath(photo, 'clipboard')).then(async response => {
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || '照片读取失败，请重试。'); }
      return response.blob();
    });
    // The write must start during the click, before fetching finishes (Safari).
    // Handle fetch failures even if clipboard permission is denied immediately.
    image.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
    toast(`${photo.name} 已复制到剪贴板`);
  } catch (error) {
    toast(error.name === 'NotAllowedError' ? '无法写入剪贴板，请允许剪贴板访问后重试。' : `复制 ${photo.name} 失败：${error.message || '请重试。'}`, true);
  } finally { state.copying = false; updateControls(); }
}

async function savePhoto() {
  const photo = state.photos[state.index];
  if (!photo || state.scanning || state.saving || state.targetChanging || state.targetLoading || !state.destinationAvailable) return;
  const target = state.targetPath;
  state.saving = true; updateControls();
  $('saveFeedback').classList.remove('error'); $('saveFeedback').textContent = `正在复制 ${photo.name}…`;
  try {
    const result = await post('/api/save', { id: photo.id, target });
    const key = savedKey(photo, target);
    if (!state.saved.has(key) && !result.alreadyExists) state.savedCount++;
    state.saved.set(key, result.path);
    const sameTarget = state.targetPath === target;
    const message = result.alreadyExists ? `${result.name} 已在${sameTarget ? '此目录中' : target}` : `${result.name} 已保存${result.renamed ? '（同名文件自动编号）' : ''}`;
    if (sameTarget) $('saveFeedback').textContent = `${message}\n${result.path}`;
    toast(sameTarget ? message : `${message} · ${result.path}`);
    if (state.targetPath === target) renderFilmstrip();
    return result;
  } catch (error) {
    if (state.targetPath === target) { $('saveFeedback').classList.add('error'); $('saveFeedback').textContent = error.message; }
    toast(`${photo.name} 保存到 ${target} 失败：${error.message}`, true);
    await loadTarget();
    return { error: error.message };
  } finally { state.saving = false; updateControls(); }
}

async function openBrowser(kind) {
  state.browseKind = kind;
  $('dialogTitle').textContent = kind === 'source' ? '选择照片来源' : '选择保存文件夹';
  $('folderDialog').showModal();
  $('nativePicker').hidden = !state.config.nativePicker;
  const initial = kind === 'source' ? state.sourcePath || state.config.sourcePath : state.targetPath;
  await browse(initial);
}

async function browse(folder) {
  const version = ++state.browseVersion;
  $('folderPathInput').value = folder; $('browseError').hidden = true; $('selectFolder').disabled = true;
  folderMessage($('browseFolders'), '正在读取文件夹…');
  try {
    const result = await api(`/api/folders?path=${encodeURIComponent(folder)}`);
    if (version !== state.browseVersion) return;
    state.browsePath = result.path; $('browsePath').textContent = result.path; $('folderPathInput').value = result.path;
    $('browseParent').disabled = result.path === '/';
    if (!result.folders.length) folderMessage($('browseFolders'), '没有子文件夹');
    else $('browseFolders').replaceChildren(...result.folders.map(folder => folderButton(folder, browse)));
    $('selectFolder').disabled = false;
  } catch (error) {
    if (version !== state.browseVersion) return;
    state.browsePath = ''; $('browsePath').textContent = '选择其他位置'; $('browseFolders').replaceChildren();
    $('browseError').textContent = error.message; $('browseError').hidden = false;
  }
}

async function selectBrowsedFolder() {
  if (!state.browsePath || state.selecting) return;
  state.selecting = true; $('selectFolder').disabled = true;
  try {
    if (state.browseKind === 'source') { $('folderDialog').close(); await scan(state.browsePath); }
    else if (await chooseTarget(state.browsePath, state.browsePath)) $('folderDialog').close();
  } finally { state.selecting = false; $('selectFolder').disabled = !state.browsePath; }
}

function openNewFolder() {
  $('folderNameInput').value = ''; $('createError').hidden = true; $('newFolderParent').textContent = state.targetPath;
  $('newFolderDialog').showModal(); $('folderNameInput').focus();
}

$('previous').addEventListener('click', () => navigate(-1));
$('next').addEventListener('click', () => navigate(1));
$('copy').addEventListener('click', copyPhoto);
$('save').addEventListener('click', savePhoto);
$('rescan').addEventListener('click', () => scan(state.sourcePath || state.config.sourcePath));
$('changeSource').addEventListener('click', () => openBrowser('source'));
$('stateAction').addEventListener('click', () => openBrowser('source'));
$('changeTarget').addEventListener('click', () => openBrowser('target'));
$('parentFolder').addEventListener('click', () => chooseTarget(state.targetPath.split('/').slice(0, -1).join('/') || '/'));
$('newFolder').addEventListener('click', openNewFolder);
$('retryTarget').addEventListener('click', loadTarget);
$('closeDialog').addEventListener('click', () => $('folderDialog').close());
$('pathForm').addEventListener('submit', event => { event.preventDefault(); browse($('folderPathInput').value); });
$('browseParent').addEventListener('click', () => browse(state.browsePath ? state.browsePath.split('/').slice(0, -1).join('/') || '/' : '/Volumes'));
$('selectFolder').addEventListener('click', selectBrowsedFolder);
$('nativePicker').addEventListener('click', async () => {
  $('nativePicker').disabled = true;
  try { const result = await post('/api/pick-folder', { kind: state.browseKind }); if (!result.cancelled) await browse(result.path); }
  catch (error) { $('browseError').textContent = error.message; $('browseError').hidden = false; }
  finally { $('nativePicker').disabled = false; }
});
$('closeNewFolder').addEventListener('click', () => $('newFolderDialog').close());
$('cancelNewFolder').addEventListener('click', () => $('newFolderDialog').close());
$('newFolderForm').addEventListener('submit', async event => {
  event.preventDefault(); $('createFolder').disabled = true; $('createError').hidden = true;
  $('closeNewFolder').disabled = true; $('cancelNewFolder').disabled = true;
  try {
    const result = await post('/api/folders', { parent: $('newFolderParent').textContent, name: $('folderNameInput').value });
    if (await chooseTarget(result.path)) { $('newFolderDialog').close(); toast('文件夹已创建并选中'); }
  } catch (error) { $('createError').textContent = error.message; $('createError').hidden = false; }
  finally { $('createFolder').disabled = false; $('closeNewFolder').disabled = false; $('cancelNewFolder').disabled = false; }
});
$('newFolderDialog').addEventListener('cancel', event => { if ($('createFolder').disabled) event.preventDefault(); });
$('retryPreview').addEventListener('click', () => loadPreview(state.photos[state.index]));
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('viewer').requestFullscreen(); }
  catch { toast('当前浏览器不支持全屏查看。', true); }
});
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
  else if (event.key.toLowerCase() === 's') { event.preventDefault(); savePhoto(); }
});

async function init() {
  try {
    state.config = await api('/api/config'); state.sourcePath = state.config.sourcePath;
    state.targetPath = state.config.targetPath; state.destinationRoot = state.config.destinationRoot; state.destinationAvailable = state.config.destinationAvailable;
    updateTargetDisplay();
    const locations = await api('/api/locations');
    const shortcuts = [{ name: '相机默认目录', path: state.config.defaults.sourcePath }, { name: 'NAS · 2026', path: state.config.defaults.destinationRoot }, ...locations.locations];
    $('locations').replaceChildren(...shortcuts.map(location => { const button = document.createElement('button'); button.textContent = location.name; button.title = location.path; button.addEventListener('click', () => browse(location.path)); return button; }));
    await Promise.all([scan(state.sourcePath), loadTarget()]);
  } catch (error) { setViewerState('工具无法连接', `${error.message} 请确认本地服务正在运行。`); toast(error.message, true); }
}

// Progressive enhancement: browsers supporting WebMCP share the visible actions.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = tool => {
    try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {}
  };
  register({ name: 'read_photo_selection', description: '读取当前照片、浏览位置和归档目标目录。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => ({ photo: state.photos[state.index] ?? null, position: state.index + 1, total: state.photos.length, targetPath: state.targetPath, saving: state.saving }) });
  register({ name: 'navigate_photo', description: '在照片工作区中显示上一张或下一张。', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['previous', 'next'] } }, required: ['direction'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute: input => { if (!input || !['previous', 'next'].includes(input.direction)) throw new Error('direction 必须是 previous 或 next。'); navigate(input.direction === 'previous' ? -1 : 1); return { photo: state.photos[state.index] ?? null, position: state.index + 1 }; } });
  register({ name: 'save_current_original', description: '把当前照片原图复制到页面选定的目标文件夹。完成校验后返回保存结果。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: async () => { if (!state.photos.length || !state.destinationAvailable || state.scanning || state.saving || state.targetLoading || state.targetChanging) throw new Error('当前无法保存照片，请检查照片和目标目录。'); const result = await savePhoto(); if (result?.error) throw new Error(result.error); return result; } });
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
init();
