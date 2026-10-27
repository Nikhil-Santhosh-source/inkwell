// App shell: library and editor views, routed by the URL hash.

import { NoteStore } from './storage.js';
import { createAutosaver } from './autosave.js';
import { DocumentView } from './document-view.js';
import {
  DEFAULT_PAPER, PAGE_SIZES, PEN_STYLES, PEN_STYLE_DEFAULTS, createImageItem, createPage, createTextItem, getItems,
  getPaper, isWhiteboard, newId, pageAssetIds,
} from './model.js';
import {
  History, addItemsCommand, addStrokesCommand, applyCommand, batchCommand, invertCommand, isEmptyCommand,
  lockCommand, paperCommand, recolorStrokesCommand, removeItemsCommand, removeSelectionCommand,
  removeStrokesCommand, translateStroke, updateCommand,
} from './commands.js';
import { PAPER_COLORS, PAPER_TEMPLATES, drawPaper } from './paper.js';
import { cachedBounds, layoutText, onAssetLoaded, renderThumbnail, setAssetSource, textHeight } from './render.js';
import { buildPdf } from './pdf.js';
import { imageFileToAsset, pdfToPages } from './media.js';
import { followConnectors, itemBounds, unionBounds } from './geometry.js';
import { finitePage } from './whiteboard.js';
import { safeFileName } from './util.js';
import { APP_VERSION } from './version.js';
import { applyTheme, loadTheme, onThemeChange, renderThemePicker } from './theme.js';

const $ = (id) => document.getElementById(id);

const views = { library: $('library'), editor: $('editor') };
const docList = $('doc-list');
const libraryEmpty = $('library-empty');
const docTitle = $('doc-title');
const saveStatus = $('save-status');
const fingerDraw = $('finger-draw');
const banner = $('banner');
const toast = $('toast');
const selectionBar = $('selection-bar');
const pasteBar = $('paste-bar');
const pagePanel = $('page-panel');
const textEditor = $('text-editor');

const STATUS_TEXT = { pending: 'Edited', saving: 'Saving…', saved: 'Saved', error: 'Couldn’t save — retrying' };

// ---- Tool settings (remembered per device) ----

const PEN_COLORS = ['#1d1d1f', '#1f5fd1', '#d12f2f', '#1d8a4a', '#7b3fc4', '#e07b00', '#ffffff'];
const HIGHLIGHTER_COLORS = ['#ffd60a', '#7ee08a', '#7cc7ff', '#ff8fc8', '#ffb35c'];
// Default quick sizes per tool (page units; font size for text). Each tool
// also has an exact size anywhere in its range, set with the size slider.
const SIZES = { pen: [1.5, 2.5, 4.5], highlighter: [10, 16, 26], eraser: [6, 14, 28], text: [16, 24, 36] };
const SIZE_RANGES = { pen: [0.5, 20], highlighter: [4, 60], eraser: [3, 80], text: [8, 96] };
const SIZE_TOOLS = Object.keys(SIZES);
const roundSize = (v) => Math.round(v * 10) / 10;
const TOOL_KEYS = {
  p: 'pen', 1: 'pen', h: 'highlighter', 2: 'highlighter', e: 'eraser', 3: 'eraser', l: 'lasso', 4: 'lasso',
  t: 'text', 5: 'text', s: 'space', 6: 'space',
};
const COLOR_TOOLS = new Set(['pen', 'highlighter', 'text', 'lasso']);
const MAX_FAVORITES = 6;
const SETTINGS_KEY = 'inkwell.tools.v1';
const THUMB_WIDTH = 132;

const DEFAULT_TOOLS = {
  tool: 'pen',
  // width: the tool's exact size; presets: its three quick sizes (user-editable)
  pen: { color: PEN_COLORS[0], width: SIZES.pen[1], presets: SIZES.pen, style: 'ballpoint' },
  highlighter: { color: HIGHLIGHTER_COLORS[0], width: SIZES.highlighter[1], presets: SIZES.highlighter, stab: 0 },
  eraser: { width: SIZES.eraser[1], presets: SIZES.eraser, mode: 'stroke' },
  text: { color: PEN_COLORS[0], width: SIZES.text[1], presets: SIZES.text },
  penSettings: structuredClone(PEN_STYLE_DEFAULTS), // per pen style: sens, taper, flat, stab
  gestures: { scribble: true, circle: true, doubleTap: false },
  favorites: [],
  allowFinger: false,
  showPages: false,
  minimap: true,
  zoom: 1,
  sort: 'modified',
  // Floating toolbar: position as fractions of the free space (so it stays
  // put across rotation), and whether it's collapsed to just the tools.
  toolbarPos: { x: 0.5, y: 0 },
  toolbarCompact: false,
  toolbarVertical: false, // docked upright at the left or right edge
};

function loadTools() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved && typeof saved === 'object') {
      const merged = { ...DEFAULT_TOOLS, ...saved };
      for (const key of ['pen', 'highlighter', 'eraser', 'text', 'gestures']) merged[key] = { ...DEFAULT_TOOLS[key], ...saved[key] };
      merged.penSettings = Object.fromEntries(Object.entries(PEN_STYLE_DEFAULTS)
        .map(([style, defaults]) => [style, { ...defaults, ...saved.penSettings?.[style] }]));
      // Settings saved before exact sizes existed stored a preset index.
      for (const key of SIZE_TOOLS) {
        const t = merged[key];
        if (Number.isInteger(saved[key]?.size) && saved[key].width === undefined) t.width = SIZES[key][saved[key].size] ?? SIZES[key][1];
        delete t.size;
        // Three slots; a removed one is null.
        if (!Array.isArray(t.presets) || t.presets.length !== 3) t.presets = SIZES[key];
        t.presets = t.presets.map((p) => (Number.isFinite(p) ? p : null));
      }
      return merged;
    }
  } catch { /* storage unavailable or corrupt: use defaults */ }
  return structuredClone(DEFAULT_TOOLS);
}

function saveTools() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(tools)); } catch { /* not critical */ }
}

const tools = loadTools();

function viewTool() {
  const { tool } = tools;
  switch (tool) {
    case 'pen': {
      const { style } = tools.pen;
      const s = tools.penSettings[style];
      const pen = { tool, color: tools.pen.color, width: tools.pen.width, style, sens: s.sens, taper: s.taper, stabilize: s.stab };
      if (style === 'fountain') pen.flat = s.flat;
      return pen;
    }
    case 'highlighter':
      return { tool, color: tools.highlighter.color, width: tools.highlighter.width, stabilize: tools.highlighter.stab };
    case 'eraser': return { tool, width: tools.eraser.width, mode: tools.eraser.mode };
    default: return { tool };
  }
}

let store;
// { doc, pages, view, saver, dirty: Map<pageId, page>, history, current }
let editor = null;
let routeToken = 0;
let zoomSaveTimer = null;
let clipboard = null; // { strokes, items, bounds } copied from a selection
const library = { folderId: null, query: '' };

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function showBanner(message) {
  banner.textContent = message;
  banner.hidden = !message;
}

let toastTimer = null;
function showToast(message, sticky = false) {
  toast.textContent = message;
  toast.hidden = !message;
  clearTimeout(toastTimer);
  if (message && !sticky) toastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
}

// ---- Dialogs ----

// Resolves with the pressed button's value, or '' when dismissed (Esc).
// Listens for the form submit, which fires at once, as well as 'close',
// which browsers may deliver late.
function dialogResult(dialog) {
  const form = dialog.querySelector('form');
  return new Promise((resolve) => {
    const done = (value) => {
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onSubmit = (event) => done(event.submitter?.value ?? 'ok');
    const onClose = () => done(dialog.returnValue);
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

async function askText(title, initial, okLabel) {
  const dialog = $('text-dialog');
  const input = $('text-dialog-input');
  $('text-dialog-title').textContent = title;
  $('text-dialog-ok').textContent = okLabel;
  input.value = initial;
  dialog.returnValue = '';
  dialog.showModal();
  input.select();
  return (await dialogResult(dialog)) === 'ok' ? input.value : null;
}

async function confirmAction(title, message, okLabel) {
  const dialog = $('confirm-dialog');
  $('confirm-dialog-title').textContent = title;
  $('confirm-dialog-message').textContent = message;
  $('confirm-dialog-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return (await dialogResult(dialog)) === 'ok';
}

// Lets the user pick one of `options` ([{ value, label }]); resolves with the value or null.
async function choose(title, options, selected, okLabel) {
  const dialog = $('choice-dialog');
  const select = $('choice-select');
  $('choice-title').textContent = title;
  $('choice-ok').textContent = okLabel;
  select.replaceChildren(...options.map(({ value, label }) => new Option(label, value, false, value === selected)));
  dialog.returnValue = '';
  dialog.showModal();
  return (await dialogResult(dialog)) === 'ok' ? select.value : null;
}

// Shares a file when the device can (https only); otherwise downloads it,
// which on iPad opens it with Safari's own Share button.
async function saveFile(data, name, mime) {
  const file = new File([data], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function pickFile(input) {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

// ---- Library ----

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let folders = [];

function sortDocs(docs) {
  const by = {
    modified: (a, b) => b.modifiedAt - a.modifiedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
  }[tools.sort] ?? ((a, b) => b.modifiedAt - a.modifiedAt);
  return docs.sort(by);
}

function chip(label, pressed, onClick, extraClass = '') {
  const button = document.createElement('button');
  button.className = `chip ${extraClass}`.trim();
  button.textContent = label;
  if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function renderFolderBar() {
  const filterTo = (id) => () => { library.folderId = id; renderLibrary(); };
  const chips = [
    chip('All notebooks', library.folderId === null, filterTo(null)),
    ...folders.map((f) => chip(f.name, library.folderId === f.id, filterTo(f.id))),
  ];
  const active = folders.find((f) => f.id === library.folderId);
  if (active) {
    chips.push(
      chip('Rename folder', null, () => renameFolder(active), 'subtle'),
      chip('Delete folder', null, () => deleteFolder(active), 'subtle'),
    );
  }
  $('folder-bar').replaceChildren(...chips);
  $('folder-bar').hidden = folders.length === 0;
}

// Each notebook gets its own cover colour, picked from its id so it stays put.
const COVER_HUES = [238, 12, 153, 204, 37, 338, 268, 174];

function coverHue(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COVER_HUES[h % COVER_HUES.length];
}

let cardMenuDoc = null;

// Covers are drawn once per version of a notebook (and redrawn when its
// pages change), so searching and sorting don't redraw every cover.
const coverCache = new Map(); // doc id → { key, canvas }

async function coverFor(doc) {
  const key = `${doc.modifiedAt}:${doc.pageIds[0]}`;
  const cached = coverCache.get(doc.id);
  if (cached?.key === key) return cached.canvas;
  const page = await store.getPage(doc.pageIds[0]).catch(() => null);
  if (!page) return null;
  const canvas = document.createElement('canvas');
  renderThumbnail(canvas, page, 120);
  coverCache.set(doc.id, { key, canvas });
  return canvas;
}

function openCardMenu(doc, button) {
  const menu = $('card-menu');
  if (!menu.hidden && cardMenuDoc?.id === doc.id) {
    closeCardMenu();
    return;
  }
  closePopovers();
  cardMenuDoc = doc;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const host = $('library').getBoundingClientRect();
  const r = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = r.right - width - host.left;
  left = Math.max(8, Math.min(left, host.width - width - 8));
  let top = r.bottom + 6 - host.top;
  if (r.bottom + 6 + height > window.innerHeight - 8) top = r.top - height - 6 - host.top;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.right = 'auto';
}

function closeCardMenu() {
  $('card-menu').hidden = true;
  for (const b of document.querySelectorAll('.doc-more[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
}

async function renderLibrary() {
  folders = await store.listFolders();
  if (library.folderId && !folders.some((f) => f.id === library.folderId)) library.folderId = null;
  renderFolderBar();
  closeCardMenu();
  const query = library.query.trim().toLocaleLowerCase();
  const docs = sortDocs((await store.listDocuments())
    .filter((d) => library.folderId === null || d.folderId === library.folderId)
    .filter((d) => !query || d.title.toLocaleLowerCase().includes(query)));
  const covers = await Promise.all(docs.map(coverFor));
  docList.replaceChildren(...docs.map((doc, i) => {
    const item = document.createElement('li');
    item.className = 'doc-card';
    const href = `#/doc/${encodeURIComponent(doc.id)}`;
    const whiteboard = doc.kind === 'whiteboard';

    const cover = document.createElement('div');
    cover.className = `doc-cover${whiteboard ? ' whiteboard' : ''}`;
    cover.style.setProperty('--cover-h', coverHue(doc.id));
    if (covers[i]) cover.append(covers[i]);
    const badge = document.createElement('span');
    badge.className = 'doc-badge';
    badge.textContent = whiteboard ? 'Board' : `${doc.pageIds.length} ${doc.pageIds.length === 1 ? 'page' : 'pages'}`;
    cover.append(badge);
    cover.addEventListener('click', () => { location.hash = href; });

    const open = document.createElement('a');
    open.className = 'doc-open';
    open.href = href;
    const title = document.createElement('span');
    title.className = 'doc-title';
    title.textContent = doc.title;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    const folder = library.folderId === null && folders.find((f) => f.id === doc.folderId);
    meta.textContent = `${folder ? `${folder.name} · ` : ''}${dateFormat.format(doc.modifiedAt)}`;
    open.append(title, meta);

    const more = document.createElement('button');
    more.className = 'doc-more';
    more.setAttribute('aria-label', `Options for ${doc.title}`);
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>';
    more.addEventListener('click', () => openCardMenu(doc, more));

    const info = document.createElement('div');
    info.className = 'doc-info';
    info.append(open, more);
    item.append(cover, info);
    return item;
  }));
  const filtered = Boolean(query || library.folderId);
  libraryEmpty.hidden = docs.length > 0;
  $('library-empty-title').textContent = filtered ? 'Nothing here' : 'Your shelf is empty';
  $('library-empty-text').textContent = filtered
    ? 'No notebooks match. Try another search or folder.'
    : 'Make a notebook for each class, or a whiteboard for brainstorming.';
  $('empty-new-doc').hidden = filtered;
  const active = folders.find((f) => f.id === library.folderId);
  $('library-heading-title').textContent = active ? active.name : 'Notebooks';
  $('library-count').textContent = docs.length ? String(docs.length) : '';
  updateBackupReminder(docs.length > 0);
}

async function newDocument() {
  const dialog = $('new-doc-dialog');
  $('new-doc-size').replaceChildren(...PAGE_SIZES.map((s) => new Option(s.label, s.id)));
  $('new-doc-paper').replaceChildren(...PAPER_TEMPLATES.map((t) => new Option(t.label, t.id, false, t.id === DEFAULT_PAPER.template)));
  const title = $('new-doc-title');
  const kind = $('new-doc-kind');
  kind.value = 'notebook';
  kind.onchange = () => dialog.classList.toggle('whiteboard', kind.value === 'whiteboard');
  kind.onchange();
  title.value = 'Untitled';
  dialog.returnValue = '';
  dialog.showModal();
  title.select();
  if ((await dialogResult(dialog)) !== 'ok') return;
  const size = PAGE_SIZES.find((s) => s.id === $('new-doc-size').value) ?? PAGE_SIZES[0];
  const doc = await store.createDocument(title.value, {
    kind: kind.value,
    height: size.height,
    paper: { ...DEFAULT_PAPER, template: $('new-doc-paper').value },
    folderId: library.folderId,
  });
  location.hash = `#/doc/${encodeURIComponent(doc.id)}`;
}

async function renameDocument(doc) {
  const title = await askText('Rename notebook', doc.title, 'Rename');
  if (title === null) return;
  await store.renameDocument(doc.id, title);
  await renderLibrary();
}

async function moveDocument(doc) {
  const options = [{ value: '', label: 'No folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))];
  if (folders.length === 0) {
    showToast('Create a folder first (⋯ → New folder).');
    return;
  }
  const choice = await choose(`Move “${doc.title}” to`, options, doc.folderId ?? '', 'Move');
  if (choice === null) return;
  await store.moveDocument(doc.id, choice || null);
  await renderLibrary();
}

async function duplicateDocument(doc) {
  const copy = await store.duplicateDocument(doc.id);
  showToast(`Made “${copy.title}”`);
  await renderLibrary();
}

async function deleteDocument(doc) {
  const ok = await confirmAction('Delete notebook?', `“${doc.title}” and all its pages will be deleted. This can’t be undone.`, 'Delete');
  if (!ok) return;
  await store.deleteDocument(doc.id);
  await renderLibrary();
}

async function newFolder() {
  closePopovers();
  const name = await askText('New folder', 'New folder', 'Create');
  if (name === null) return;
  const folder = await store.createFolder(name);
  library.folderId = folder.id;
  await renderLibrary();
}

async function renameFolder(folder) {
  const name = await askText('Rename folder', folder.name, 'Rename');
  if (name === null) return;
  await store.renameFolder(folder.id, name);
  await renderLibrary();
}

async function deleteFolder(folder) {
  const ok = await confirmAction(`Delete folder “${folder.name}”?`, 'Its notebooks are kept and move to All notebooks.', 'Delete folder');
  if (!ok) return;
  await store.deleteFolder(folder.id);
  library.folderId = null;
  await renderLibrary();
}

async function importPdf() {
  closePopovers();
  const file = await pickFile($('pdf-input'));
  if (!file) return;
  try {
    showToast('Opening PDF…', true);
    const { pages, assets } = await pdfToPages(new Uint8Array(await file.arrayBuffer()), {
      onProgress: (done, total) => showToast(`Importing page ${done} of ${total}…`, true),
    });
    const title = file.name.replace(/\.pdf$/i, '');
    const doc = await store.createDocumentWithPages(title, pages, assets, library.folderId);
    showToast(`Imported ${pages.length} page${pages.length === 1 ? '' : 's'}`);
    location.hash = `#/doc/${encodeURIComponent(doc.id)}`;
  } catch (err) {
    console.error(err);
    showToast('');
    showBanner(`Couldn’t import that PDF: ${err.message}`);
  }
}

// Notes live only on this iPad, so the library nudges you to back up weekly.
const BACKUP_KEY = 'inkwell.lastBackup';
const BACKUP_EVERY_DAYS = 7;

function markBackedUp() {
  try { localStorage.setItem(BACKUP_KEY, String(Date.now())); } catch { /* not critical */ }
  updateBackupReminder(true);
}

function updateBackupReminder(hasNotes) {
  let last = 0;
  try { last = Number(localStorage.getItem(BACKUP_KEY)) || 0; } catch { /* treat as never */ }
  const days = Math.floor((Date.now() - last) / 86_400_000);
  const due = hasNotes && (!last || days >= BACKUP_EVERY_DAYS);
  $('backup-reminder').hidden = !due;
  $('backup-reminder-text').textContent = last
    ? `Last backup ${days} day${days === 1 ? '' : 's'} ago. Back up so your notes are safe if this iPad is lost or reset.`
    : 'Your notes are stored only on this iPad. Back up so they’re safe if it’s lost or reset.';
}

async function backupLibrary() {
  closePopovers();
  try {
    showToast('Preparing backup…', true);
    const backup = await store.exportBackup();
    const date = new Date().toISOString().slice(0, 10);
    showToast('');
    await saveFile(JSON.stringify(backup), `Inkwell backup ${date}.json`, 'application/json');
    markBackedUp();
  } catch (err) {
    showToast('');
    showBanner(`Couldn’t back up: ${err.message}`);
  }
}

async function restoreLibrary() {
  closePopovers();
  const file = await pickFile($('restore-input'));
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const ok = await confirmAction('Restore this backup?', 'Its notebooks are added alongside your current ones. Nothing is overwritten.', 'Restore');
    if (!ok) return;
    const result = await store.importBackup(backup);
    showToast(`Restored ${result.documents} notebook${result.documents === 1 ? '' : 's'}`);
    await renderLibrary();
  } catch (err) {
    showBanner(`Couldn’t restore: ${err instanceof SyntaxError ? 'the file isn’t a backup' : err.message}`);
  }
}

// ---- Editing ----

function pageIndex(pageId) {
  return editor.pages.findIndex((p) => p.id === pageId);
}

function pageById(pageId) {
  return editor.pages[pageIndex(pageId)];
}

function currentPage() {
  return editor.pages[editor.current] ?? editor.pages[0];
}

// Applies an edit to a page, records it for undo, redraws and schedules a save.
// Moving shapes also stretches the connectors attached to them, in the same step.
function edit(pageId, command) {
  if (!editor || isEmptyCommand(command) || pageIndex(pageId) < 0) return;
  const page = pageById(pageId);
  let cmd = command;
  if (cmd.type === 'move') {
    const followers = followConnectors(page.strokes, [...cmd.ids, ...(cmd.itemIds ?? [])], cmd.dx, cmd.dy);
    if (followers.length) cmd = batchCommand([cmd, updateCommand(followers, [])]);
  }
  editor.history.record({ pageId, cmd });
  replacePage(applyCommand(page, cmd));
}

function replacePage(page) {
  const index = pageIndex(page.id);
  editor.pages = editor.pages.map((p, i) => (i === index ? page : p));
  editor.dirty.set(page.id, page);
  editor.saver.schedule(true);
  refreshEditor();
}

function refreshEditor() {
  editor.view.setPages(editor.pages);
  updatePageIndicator();
  updateUndoButtons();
  renderPaperMenu();
  schedulePagePanel();
}

// The page sidebar is rebuilt shortly after edits stop, not after every stroke.
// Thumbnails are redrawn once writing pauses: never while the Pencil is
// down, so redrawing them can't stutter the next stroke.
let panelTimer = null;
function schedulePagePanel() {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    if (editor?.view.action) schedulePagePanel();
    else renderPagePanel();
  }, 600);
}

function revert(entry, cmd) {
  const index = pageIndex(entry.pageId);
  if (index < 0) return;
  if (index !== editor.current) editor.view.scrollToPage(index);
  replacePage(applyCommand(editor.pages[index], cmd));
}

function undo() {
  commitText();
  const entry = editor?.history.undo();
  if (entry) revert(entry, invertCommand(entry.cmd));
}

function redo() {
  commitText();
  const entry = editor?.history.redo();
  if (entry) revert(entry, entry.cmd);
}

function updateUndoButtons() {
  $('undo').disabled = !editor?.history.canUndo;
  $('redo').disabled = !editor?.history.canRedo;
}

// ---- Selection, clipboard ----

function selectedContent() {
  const info = editor?.view.selectionInfo;
  if (!info) return null;
  const page = pageById(info.pageId);
  if (!page) return null;
  const ids = new Set(info.ids);
  const itemIds = new Set(info.itemIds);
  return {
    page,
    strokes: page.strokes.filter((s) => ids.has(s.id)),
    items: getItems(page).filter((i) => itemIds.has(i.id)),
  };
}

function deleteSelection() {
  const sel = selectedContent();
  if (sel) edit(sel.page.id, removeSelectionCommand(sel.page, sel.strokes.map((s) => s.id), sel.items.map((i) => i.id)));
}

// Copies of strokes and items under new ids, shifted by (dx, dy). Copies are
// unlocked, and copied connectors no longer attach to the original shapes.
function cloneContent(strokes, items, dx, dy) {
  return {
    strokes: strokes.map((s) => {
      const { connect, locked, ...copy } = translateStroke(s, dx, dy);
      return { ...copy, id: newId() };
    }),
    items: items.map(({ locked, ...i }) => ({ ...i, id: newId(), x: i.x + dx, y: i.y + dy })),
  };
}

function lockSelection() {
  const sel = selectedContent();
  if (!sel) return;
  edit(sel.page.id, lockCommand(sel.page, sel.strokes.map((s) => s.id), sel.items.map((i) => i.id), true));
  editor.view.setSelection(null, []);
  showToast('Locked: it can’t be selected or erased until unlocked (⋯ menu)');
}

function unlockAll() {
  closePopovers();
  if (!editor) return;
  const page = currentPage();
  const cmd = lockCommand(page, page.strokes.map((s) => s.id), getItems(page).map((i) => i.id), false);
  if (isEmptyCommand(cmd)) {
    showToast('Nothing is locked here');
    return;
  }
  edit(page.id, cmd);
  showToast('Unlocked');
}

// Circle to select: after a loop is drawn around writing, offer to turn it
// into a selection. Accepting removes the loop and selects what it enclosed.
let loopOffer = null;
let loopTimer = null;

function onLoopDrawn(pageId, loopId, ids, itemIds, local) {
  loopOffer = { pageId, loopId, ids, itemIds };
  const bar = $('loop-bar');
  bar.style.left = `${local.x}px`;
  bar.style.top = `${Math.max(8, local.y - 56)}px`;
  bar.hidden = false;
  clearTimeout(loopTimer);
  loopTimer = setTimeout(hideLoopBar, 3500);
}

function hideLoopBar() {
  $('loop-bar').hidden = true;
  loopOffer = null;
}

function acceptLoop() {
  const offer = loopOffer;
  hideLoopBar();
  if (!offer || !editor) return;
  const page = pageById(offer.pageId);
  if (page) edit(page.id, removeStrokesCommand(page, [offer.loopId]));
  selectTool('lasso');
  editor.view.setSelection(offer.pageId, offer.ids, offer.itemIds);
}

// Each picture belongs to one page, so copied picture items get their own
// copy of the image. Pictures whose image is gone are dropped.
async function withOwnAssets(items) {
  const out = [];
  for (const item of items) {
    if (item.type !== 'image') {
      out.push(item);
      continue;
    }
    const asset = await store.getAsset(item.assetId);
    if (!asset) continue;
    const copy = await store.putAsset({ ...asset, id: newId() });
    out.push({ ...item, assetId: copy.id });
  }
  return out;
}

// Adds content to a page as one undoable step and selects it.
async function insertContent(page, strokes, items) {
  const ownItems = await withOwnAssets(items);
  if (!editor || !pageById(page.id)) return;
  const target = pageById(page.id);
  edit(page.id, batchCommand([addStrokesCommand(target, strokes), addItemsCommand(target, ownItems)]));
  if (tools.tool !== 'lasso') selectTool('lasso');
  editor.view.setSelection(page.id, strokes.map((s) => s.id), ownItems.map((i) => i.id));
}

async function duplicateSelection() {
  const sel = selectedContent();
  if (!sel) return;
  const copy = cloneContent(sel.strokes, sel.items, 24, 24);
  await insertContent(sel.page, copy.strokes, copy.items);
}

function copySelection() {
  const sel = selectedContent();
  if (!sel) return false;
  const bounds = unionBounds([...sel.strokes.map(cachedBounds), ...sel.items.map(itemBounds)]);
  clipboard = { strokes: sel.strokes, items: sel.items, bounds };
  showToast('Copied');
  return true;
}

function cutSelection() {
  if (copySelection()) deleteSelection();
}

// Pastes the clipboard so its top-left lands at (x, y) on the page, or
// centred in view when no point is given. Works across notebooks.
async function paste(pageId = currentPage().id, x = null, y = null) {
  if (!editor || !clipboard) return;
  hidePasteBar();
  const page = pageById(pageId);
  const { bounds } = clipboard;
  let dx;
  let dy;
  if (x === null) {
    const center = editor.view.visibleCenter(pageIndex(pageId));
    dx = center.x - (bounds.minX + bounds.maxX) / 2;
    dy = center.y - (bounds.minY + bounds.maxY) / 2;
  } else {
    dx = x - bounds.minX;
    dy = y - bounds.minY;
  }
  const copy = cloneContent(clipboard.strokes, clipboard.items, Math.round(dx * 100) / 100, Math.round(dy * 100) / 100);
  await insertContent(page, copy.strokes, copy.items);
}

let pasteTarget = null;

function onEmptyLassoTap(pageId, x, y) {
  if (!clipboard) return;
  pasteTarget = { pageId, x, y };
  const local = editor.view.pageToLocal(pageIndex(pageId), x, y);
  pasteBar.style.left = `${local.x}px`;
  pasteBar.style.top = `${Math.max(8, local.y - 56)}px`;
  pasteBar.hidden = false;
}

function hidePasteBar() {
  pasteBar.hidden = true;
  pasteTarget = null;
}

function placeSelectionBar(hasSelection) {
  if (hasSelection) hidePasteBar();
  const rect = hasSelection && editor?.view.selectionRect();
  selectionBar.hidden = !rect;
  if (!rect) return;
  const wrap = $('canvas-wrap');
  const above = rect.top - 58;
  selectionBar.style.left = `${Math.min(Math.max((rect.left + rect.right) / 2, 140), wrap.clientWidth - 140)}px`;
  selectionBar.style.top = `${above > 8 ? above : Math.min(rect.bottom + 22, wrap.clientHeight - 56)}px`;
}

// ---- Text boxes ----

let textSession = null; // { pageId, x, y, width, item, size, color }

function openTextEditor(pageId, x, y, item) {
  commitText();
  const page = pageById(pageId);
  const size = item?.size ?? tools.text.width;
  const color = item?.color ?? tools.text.color;
  const roomRight = isWhiteboard(page) ? 360 : page.width - x - 16;
  const width = item?.width ?? Math.max(120, Math.min(420, roomRight));
  const left = item?.x ?? x;
  const top = item?.y ?? y - size * 0.6;
  textSession = { pageId, x: left, y: top, width, item, size, color };
  positionTextEditor();
  textEditor.value = item?.text ?? '';
  textEditor.style.color = color === '#ffffff' ? '#1d1d1f' : color;
  textEditor.hidden = false;
  autosizeTextEditor();
  positionTextEditor();
  textEditor.focus();
}

function positionTextEditor() {
  if (!textSession) return;
  const { scale } = editor.view;
  const local = editor.view.pageToLocal(pageIndex(textSession.pageId), textSession.x, textSession.y);
  textEditor.style.left = `${local.x - 6}px`;
  textEditor.style.top = `${local.y - 4}px`;
  textEditor.style.width = `${textSession.width * scale + 12}px`;
  textEditor.style.fontSize = `${textSession.size * scale}px`;
  // Done / Delete above the box (or below it when there's no room above).
  const bar = $('text-bar');
  bar.hidden = false;
  bar.style.left = `${Math.max(110, local.x + 80)}px`;
  bar.style.top = `${local.y - 58 > 8 ? local.y - 58 : local.y + textEditor.offsetHeight + 8}px`;
}

// Deletes the text box being edited (a new, unsaved one is just discarded).
function deleteTextBox() {
  if (!textSession || !editor) return;
  const { pageId, item } = textSession;
  textSession = null;
  textEditor.hidden = true;
  $('text-bar').hidden = true;
  textEditor.blur();
  const page = pageById(pageId);
  if (item && page) edit(pageId, removeItemsCommand(page, [item.id]));
}

function autosizeTextEditor() {
  textEditor.style.height = 'auto';
  textEditor.style.height = `${textEditor.scrollHeight + 2}px`;
}

function commitText() {
  if (!textSession || !editor) return;
  const { pageId, x, y, width, item, size, color } = textSession;
  textSession = null;
  const text = textEditor.value.replace(/\s+$/, '');
  textEditor.hidden = true;
  $('text-bar').hidden = true;
  textEditor.blur();
  const page = pageById(pageId);
  if (!page) return;
  if (!text) {
    if (item) edit(pageId, removeItemsCommand(page, [item.id]));
    return;
  }
  if (item && item.text === text) return;
  const lines = layoutText(text, width, size);
  const height = textHeight(lines.length, size);
  if (item) {
    edit(pageId, updateCommand([], [{ before: item, after: { ...item, text, lines, height } }]));
  } else {
    edit(pageId, addItemsCommand(page, [createTextItem({ x, y, width, text, size, color, lines, height })]));
  }
}

// ---- Pictures ----

async function insertImage() {
  if (!editor) return;
  const file = await pickFile($('image-input'));
  if (!file || !editor) return;
  try {
    const asset = await store.putAsset(await imageFileToAsset(file));
    const page = currentPage();
    const width = Math.min(page.width * 0.6, asset.width / 2);
    const height = (width * asset.height) / asset.width;
    const center = editor.view.visibleCenter(editor.current);
    const minEdge = isWhiteboard(page) ? -Infinity : 0;
    const item = createImageItem({
      x: Math.round(Math.max(minEdge, center.x - width / 2)),
      y: Math.round(Math.max(minEdge, center.y - height / 2)),
      width: Math.round(width),
      height: Math.round(height),
      assetId: asset.id,
    });
    // The new asset is this item's own, so add it directly rather than copying it again.
    edit(page.id, addItemsCommand(page, [item]));
    if (tools.tool !== 'lasso') selectTool('lasso');
    editor.view.setSelection(page.id, [], [item.id]);
  } catch (err) {
    console.error(err);
    showBanner(`Couldn’t insert that picture: ${err.message}`);
  }
}

// ---- Pages ----

function updatePageIndicator() {
  const index = Math.min(editor.current, editor.pages.length - 1);
  $('page-indicator').textContent = `${index + 1} / ${editor.pages.length}`;
}

function onCurrentPageChange(index) {
  if (!editor) return;
  editor.current = index;
  updatePageIndicator();
  for (const [i, item] of [...$('page-list').children].entries()) item.classList.toggle('current', i === index);
  renderPaperMenu();
}

async function addPage() {
  if (!editor || isWhiteboard(currentPage())) return;
  const at = editor.current + 1;
  const from = currentPage();
  // A page after an imported PDF page gets plain paper of the same size.
  const page = createPage(from.background ? DEFAULT_PAPER : getPaper(from), from.height);
  try {
    editor.doc = await store.insertPage(editor.doc.id, page, at);
  } catch (err) {
    showBanner(`Couldn’t add a page: ${err.message}`);
    return;
  }
  editor.pages = [...editor.pages.slice(0, at), page, ...editor.pages.slice(at)];
  refreshEditor();
  editor.view.scrollToPage(at);
}

async function deletePage(index) {
  if (!editor || editor.pages.length < 2) return;
  const page = editor.pages[index];
  const ok = await confirmAction(`Delete page ${index + 1}?`, 'Its writing will be deleted. This can’t be undone.', 'Delete page');
  if (!ok || !editor) return;
  await editor.saver.flush();
  try {
    editor.doc = await store.deletePage(editor.doc.id, page.id);
  } catch (err) {
    showBanner(`Couldn’t delete the page: ${err.message}`);
    return;
  }
  editor.dirty.delete(page.id);
  editor.history.forget((entry) => entry.pageId === page.id);
  editor.pages = editor.pages.filter((p) => p.id !== page.id);
  refreshEditor();
}

async function movePage(from, to) {
  if (!editor || to === from || to < 0 || to >= editor.pages.length) return;
  const page = editor.pages[from];
  try {
    editor.doc = await store.movePage(editor.doc.id, page.id, to);
  } catch (err) {
    showBanner(`Couldn’t move the page: ${err.message}`);
    return;
  }
  const pages = editor.pages.filter((p) => p.id !== page.id);
  pages.splice(to, 0, page);
  editor.pages = pages;
  refreshEditor();
  editor.view.scrollToPage(to);
}

const ICONS = {
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" stroke-width="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

function iconButton(icon, label, onClick, disabled = false) {
  const button = document.createElement('button');
  button.innerHTML = ICONS[icon];
  button.setAttribute('aria-label', label);
  button.title = label;
  button.disabled = disabled;
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

// Dragging a thumbnail's grip reorders pages; the drop slot is shown with a line.
function startPageDrag(event, from, handle) {
  event.preventDefault();
  try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic or already gone */ }
  const items = [...$('page-list').children];
  items[from].classList.add('dragging');
  let target = from;
  const mark = () => {
    items.forEach((li, i) => {
      li.classList.toggle('drop-before', target !== from && i === target && target < from);
      li.classList.toggle('drop-after', target !== from && i === target && target > from);
    });
  };
  const onMove = (e) => {
    const y = e.clientY;
    target = items.findIndex((li) => y < li.getBoundingClientRect().bottom);
    if (target < 0) target = items.length - 1;
    // Auto-scroll the panel near its edges.
    const list = $('page-list').getBoundingClientRect();
    if (y < list.top + 30) $('page-list').scrollTop -= 12;
    if (y > list.bottom - 30) $('page-list').scrollTop += 12;
    mark();
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    items.forEach((li) => li.classList.remove('dragging', 'drop-before', 'drop-after'));
    movePage(from, target);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// Thumbnails are redrawn only for pages that changed since last time.
const thumbCache = new Map(); // pageId → { page, canvas }

function renderPagePanel() {
  if (!editor || pagePanel.hidden) return;
  const count = editor.pages.length;
  $('page-list').replaceChildren(...editor.pages.map((page, index) => {
    let cached = thumbCache.get(page.id);
    if (!cached || cached.page !== page) {
      const canvas = cached?.canvas ?? document.createElement('canvas');
      renderThumbnail(canvas, page, THUMB_WIDTH);
      cached = { page, canvas };
      thumbCache.set(page.id, cached);
    }
    const item = document.createElement('li');
    item.className = `page-thumb${index === editor.current ? ' current' : ''}`;
    const open = document.createElement('button');
    open.className = 'thumb-open';
    open.setAttribute('aria-label', `Go to page ${index + 1}`);
    open.append(cached.canvas);
    open.addEventListener('click', () => editor.view.scrollToPage(index));

    const row = document.createElement('div');
    row.className = 'thumb-row';
    const grip = iconButton('grip', `Drag to move page ${index + 1}`, null, count === 1);
    grip.classList.add('drag-handle');
    grip.addEventListener('pointerdown', (e) => startPageDrag(e, index, grip));
    const label = document.createElement('span');
    label.textContent = index + 1;
    row.append(grip, label, iconButton('trash', `Delete page ${index + 1}`, () => deletePage(index), count === 1));
    item.append(open, row);
    return item;
  }));
}

function togglePagePanel(show = pagePanel.hidden) {
  pagePanel.hidden = !show;
  $('pages-btn').setAttribute('aria-pressed', String(show));
  tools.showPages = show;
  saveTools();
  renderPagePanel();
}

// ---- Export ----

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function exportPdf() {
  if (!editor) return;
  closePopovers();
  commitText();
  const { doc, pages } = editor;
  saveStatus.textContent = 'Preparing PDF…';
  try {
    const images = new Map();
    for (const id of new Set(pages.flatMap(pageAssetIds))) {
      const asset = await store.getAsset(id);
      if (asset?.mime === 'image/jpeg') images.set(id, asset);
    }
    // A whiteboard exports as one page framed around its content.
    const bytes = await buildPdf(pages.map((p) => finitePage(p)), {
      title: doc.title,
      images,
      compress: typeof CompressionStream === 'function' ? deflate : undefined,
    });
    await saveFile(bytes, `${safeFileName(doc.title)}.pdf`, 'application/pdf');
  } catch (err) {
    console.error(err);
    showBanner(`Couldn’t export the PDF: ${err.message}`);
  } finally {
    if (editor) saveStatus.textContent = STATUS_TEXT[editor.dirty.size ? 'pending' : 'saved'];
  }
}

// ---- Toolbar ----

function selectTool(tool) {
  commitText();
  hidePasteBar();
  if (tool !== 'pen' && tool !== 'highlighter') $('pen-settings').hidden = true;
  tools.tool = tool;
  renderPenSettings();
  saveTools();
  renderToolbar();
  editor?.view.setTool(viewTool());
}

function colorToolKey() {
  if (tools.tool === 'highlighter') return 'highlighter';
  if (tools.tool === 'text') return 'text';
  return 'pen';
}

function pickColor(color) {
  $('color-menu').hidden = true;
  // With a lasso selection, a color tap recolors the selection.
  const sel = tools.tool === 'lasso' ? selectedContent() : null;
  if (sel) {
    const textChanges = sel.items.filter((i) => i.type === 'text' && i.color !== color)
      .map((before) => ({ before, after: { ...before, color } }));
    edit(sel.page.id, batchCommand([
      recolorStrokesCommand(sel.page, sel.strokes.map((s) => s.id), color),
      updateCommand([], textChanges),
    ]));
    return;
  }
  tools[colorToolKey()].color = color;
  if (tools.tool === 'lasso') tools.tool = 'pen';
  saveTools();
  renderToolbar();
  editor?.view.setTool(viewTool());
}

function addFavorite(color) {
  tools.favorites = [color, ...tools.favorites.filter((c) => c !== color)].slice(0, MAX_FAVORITES);
}

// Sets the current tool's exact size, kept within its range.
function setSize(width, { render = true } = {}) {
  const range = SIZE_RANGES[tools.tool];
  if (!range) return;
  tools[tools.tool].width = roundSize(Math.min(range[1], Math.max(range[0], width)));
  saveTools();
  if (render) {
    renderToolbar();
    renderSizeMenu();
  }
  editor?.view.setTool(viewTool());
}

// [ and ]: about 15% smaller or bigger.
function stepSize(direction) {
  if (!SIZE_RANGES[tools.tool]) return;
  setSize(tools[tools.tool].width * (direction > 0 ? 1.15 : 1 / 1.15));
}

// The size slider is logarithmic: fine steps for thin pens, big steps for wide erasers.
function sliderToSize(value, [min, max]) {
  return min * (max / min) ** (value / 1000);
}

function sizeToSlider(size, [min, max]) {
  return Math.round((Math.log(size / min) / Math.log(max / min)) * 1000);
}

function toggleSizeMenu() {
  const panel = $('size-menu');
  const open = panel.hidden;
  closePopovers();
  panel.hidden = !open;
  renderSizeMenu();
  renderToolbar();
  if (open) placeNextToToolbar(panel, document.querySelector('.size-more'));
}

// Size panel: a slider over the tool's whole range with a live preview, and
// the three quick sizes; "Save here" puts the current size in a slot.
function renderSizeMenu() {
  const panel = $('size-menu');
  const range = SIZE_RANGES[tools.tool];
  if (panel.hidden || !range) {
    if (!range) panel.hidden = true;
    return;
  }
  const t = tools[tools.tool];
  const unit = tools.tool === 'text' ? 'pt' : '';
  $('size-menu-title').textContent = { pen: 'Pen size', highlighter: 'Highlighter size', eraser: 'Eraser size', text: 'Text size' }[tools.tool];

  const preview = document.createElement('div');
  preview.className = 'size-preview';
  if (tools.tool === 'text') {
    preview.textContent = 'Aa';
    preview.style.fontSize = `${Math.min(64, t.width)}px`;
    preview.style.color = t.color;
  } else {
    const dot = document.createElement('span');
    const px = Math.min(64, Math.max(2, t.width));
    dot.style.width = dot.style.height = `${px}px`;
    dot.style.background = tools.tool === 'eraser' ? 'transparent' : t.color;
    if (tools.tool === 'eraser') dot.style.border = '1.5px solid currentColor';
    if (tools.tool === 'highlighter') dot.style.opacity = '0.45';
    preview.append(dot);
  }

  const row = document.createElement('label');
  row.className = 'slider-row';
  const name = document.createElement('span');
  name.textContent = 'Size';
  const value = document.createElement('output');
  value.textContent = `${t.width}${unit}`;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.value = String(sizeToSlider(t.width, range));
  slider.setAttribute('aria-label', 'Size');
  slider.addEventListener('input', () => {
    setSize(sliderToSize(Number(slider.value), range), { render: false });
    value.textContent = `${tools[tools.tool].width}${unit}`;
    const dot = preview.querySelector('span');
    if (dot) dot.style.width = dot.style.height = `${Math.min(64, Math.max(2, tools[tools.tool].width))}px`;
    else preview.style.fontSize = `${Math.min(64, tools[tools.tool].width)}px`;
  });
  slider.addEventListener('change', () => renderToolbar());
  const ends = document.createElement('div');
  ends.className = 'slider-ends';
  ends.innerHTML = `<span>${range[0]}${unit}</span><span>${range[1]}${unit}</span>`;
  row.append(name, value, slider);

  const slots = document.createElement('div');
  slots.className = 'preset-slots';
  const setSlot = (i, value) => {
    t.presets = t.presets.map((p, j) => (j === i ? value : p));
    saveTools();
    renderSizeMenu();
    renderToolbar();
  };
  t.presets.forEach((size, i) => {
    const slot = document.createElement('div');
    slot.className = 'preset-slot';
    const empty = size === null;
    const use = optionButton(empty ? 'Empty' : `${size}${unit}`, size === t.width, () => setSize(size));
    use.disabled = empty;
    use.setAttribute('aria-label', empty ? `Quick size ${i + 1}: empty` : `Quick size ${i + 1}: ${size}`);
    const save = document.createElement('button');
    save.className = 'option slot-action';
    save.textContent = 'Save here';
    save.title = `Make ${t.width}${unit} quick size ${i + 1}`;
    save.disabled = size === t.width;
    save.addEventListener('click', () => setSlot(i, t.width));
    const remove = document.createElement('button');
    remove.className = 'option slot-action danger';
    remove.textContent = 'Remove';
    remove.title = `Remove quick size ${i + 1}`;
    remove.disabled = empty;
    remove.addEventListener('click', () => setSlot(i, null));
    slot.append(use, save, remove);
    slots.append(slot);
  });
  const heading = document.createElement('h2');
  heading.textContent = 'Quick sizes';
  $('size-menu-body').replaceChildren(preview, row, ends, heading, slots);
}

function optionButton(label, pressed, onClick) {
  const button = document.createElement('button');
  button.className = 'option';
  button.textContent = label;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function swatch(color, pressed, label = `Color ${color}`) {
  const button = document.createElement('button');
  button.className = 'swatch';
  button.style.background = color;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', () => pickColor(color));
  return button;
}

function renderToolbar() {
  for (const button of document.querySelectorAll('.tool[data-tool]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === tools.tool));
  }

  // Pen style (+ settings), highlighter settings, or eraser mode.
  let options = [];
  if (tools.tool === 'pen') {
    // One button shows the current pen and opens the list, to keep the toolbar narrow.
    const current = PEN_STYLES.find((s) => s.id === tools.pen.style) ?? PEN_STYLES[0];
    const styleButton = optionButton('', false, toggleStyleMenu);
    styleButton.classList.add('style-btn');
    // Full name lying flat; a short one when the toolbar stands upright.
    const short = { ballpoint: 'Ball', fountain: 'Fount', brush: 'Brush', pencil: 'Pencil' }[current.id];
    styleButton.innerHTML = `<span class="long">${current.label} ▾</span><span class="short">${short}</span>`;
    styleButton.setAttribute('aria-label', `${current.label}; change pen`);
    styleButton.setAttribute('aria-haspopup', 'true');
    styleButton.setAttribute('aria-expanded', String(!$('style-menu').hidden));
    options = [styleButton, settingsButton()];
    $('style-menu-body').replaceChildren(...PEN_STYLES.map((s) => {
      const row = optionButton(s.label, tools.pen.style === s.id, () => {
        tools.pen.style = s.id;
        $('style-menu').hidden = true;
        saveTools();
        renderToolbar();
        renderPenSettings();
        editor?.view.setTool(viewTool());
      });
      row.classList.add('menu-row');
      return row;
    }));
  } else if (tools.tool === 'highlighter') {
    options = [settingsButton()];
  } else if (tools.tool === 'eraser') {
    options = [['stroke', 'Whole stroke'], ['partial', 'Partial']].map(([mode, label]) =>
      optionButton(label, tools.eraser.mode === mode, () => {
        tools.eraser.mode = mode;
        saveTools();
        renderToolbar();
        editor?.view.setTool(viewTool());
      }));
  }
  $('tool-options').replaceChildren(...options);

  const key = colorToolKey();
  const current = tools[key].color;
  const showPressed = tools.tool !== 'lasso';
  // The toolbar shows only the current colour (tap for the full palette) and
  // the eyedropper, which keeps the floating toolbar narrow.
  let colors = [];
  let menu = [];
  if (COLOR_TOOLS.has(tools.tool)) {
    const palette = key === 'highlighter' ? HIGHLIGHTER_COLORS : [...PEN_COLORS, ...tools.favorites.filter((c) => !PEN_COLORS.includes(c))];
    menu = palette.map((color) => swatch(color, showPressed && color === current));
    const custom = document.createElement('label');
    custom.className = 'custom-color';
    custom.title = 'Custom color (saved to your favorites)';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current;
    input.setAttribute('aria-label', 'Custom color');
    input.addEventListener('change', () => {
      if (key !== 'highlighter') addFavorite(input.value);
      pickColor(input.value);
    });
    custom.append(input);
    menu.push(custom);

    const currentButton = document.createElement('button');
    currentButton.className = 'swatch current-color color-btn';
    currentButton.style.background = tools.tool === 'lasso'
      ? 'conic-gradient(#d12f2f, #e07b00, #1d8a4a, #1f5fd1, #7b3fc4, #d12f2f)'
      : current;
    currentButton.setAttribute('aria-label', tools.tool === 'lasso' ? 'Recolor selection' : `Colour ${current}; tap for more`);
    currentButton.setAttribute('aria-haspopup', 'true');
    currentButton.setAttribute('aria-expanded', String(!$('color-menu').hidden));
    currentButton.addEventListener('click', toggleColorMenu);
    colors = [currentButton, eyedropperButton()];
  }
  $('colors').replaceChildren(...colors);
  $('color-menu-body').replaceChildren(...menu);
  if (!menu.length) $('color-menu').hidden = true;

  // Three quick sizes (dots/letters grow with the size), then the exact size,
  // which opens the size panel.
  const t = tools[tools.tool];
  const range = SIZE_RANGES[tools.tool];
  let sizeButtons = [];
  if (range) {
    // Removed (empty) slots don't appear on the toolbar.
    const filled = t.presets.filter((p) => p !== null);
    const sorted = [...filled].sort((a, b) => a - b);
    sizeButtons = filled.map((size) => {
      const button = document.createElement('button');
      button.className = 'size';
      button.setAttribute('aria-label', `Size ${size}`);
      button.title = `${size}`;
      button.setAttribute('aria-pressed', String(t.width === size));
      const rank = sorted.indexOf(size);
      if (tools.tool === 'text') {
        button.textContent = 'A';
        button.style.fontSize = `${12 + rank * 5}px`;
      } else {
        const dot = document.createElement('span');
        dot.style.width = dot.style.height = `${4 + rank * 5}px`;
        button.append(dot);
      }
      button.addEventListener('click', () => setSize(size));
      return button;
    });
    const more = document.createElement('button');
    more.className = 'option size-more';
    more.textContent = `${t.width}`;
    more.title = 'Exact size and quick sizes';
    more.setAttribute('aria-label', `Size ${t.width}; more sizes`);
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-expanded', String(!$('size-menu').hidden));
    more.addEventListener('click', toggleSizeMenu);
    sizeButtons.push(more);
  }
  $('sizes').replaceChildren(...sizeButtons);
  $('sizes-divider').hidden = sizeButtons.length === 0;
  placeToolbar(); // its size changes with the tool's options
}

// ---- Floating toolbar ----

const TOOLBAR_MARGIN = 8;

// The area the toolbar may float in: the editor below its header, in px
// relative to the editor.
function toolbarArea() {
  const editorRect = views.editor.getBoundingClientRect();
  const header = views.editor.querySelector('.editor-bar').getBoundingClientRect();
  const bar = $('toolbar');
  const top = header.bottom - editorRect.top + TOOLBAR_MARGIN;
  return {
    left: TOOLBAR_MARGIN,
    top,
    freeW: Math.max(0, editorRect.width - bar.offsetWidth - TOOLBAR_MARGIN * 2),
    freeH: Math.max(0, editorRect.height - top - bar.offsetHeight - TOOLBAR_MARGIN),
  };
}

function placeToolbar() {
  if (views.editor.hidden) return;
  const bar = $('toolbar');
  bar.classList.toggle('vertical', tools.toolbarVertical);
  bar.classList.toggle('compact', tools.toolbarCompact);
  const area = toolbarArea();
  bar.style.left = `${area.left + area.freeW * tools.toolbarPos.x}px`;
  bar.style.top = `${area.top + area.freeH * tools.toolbarPos.y}px`;
  $('toolbar-collapse').setAttribute('aria-expanded', String(!tools.toolbarCompact));
  $('toolbar-grip').setAttribute('aria-label', 'Drag to move the toolbar. Drag it to the left or right edge to stand it upright.');
}

const EDGE_SNAP = 56; // px from the left/right edge where the toolbar turns vertical
const HOLD_TO_MOVE = 380; // ms holding a button before the toolbar moves instead

// Moving the toolbar: drag its grip or any empty part straight away, or hold
// a button for a moment and then drag (a quick tap still presses the button).
// Dropped near the left or right edge it stands upright along that edge;
// anywhere else it lies flat. Its place is saved as a share of the free space.
function setupFloatingToolbar() {
  const bar = $('toolbar');
  const grip = $('toolbar-grip');

  bar.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    const onControl = Boolean(event.target.closest('button, input, label, select')) && !grip.contains(event.target);
    const start = { x: event.clientX, y: event.clientY };
    let grab = null; // pointer offset inside the toolbar once dragging
    let holdTimer = 0;

    const begin = () => {
      const rect = bar.getBoundingClientRect();
      grab = { x: start.x - rect.left, y: start.y - rect.top };
      bar.classList.add('dragging');
      closePopovers();
      try { bar.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
      navigator.vibrate?.(10);
    };

    const moveTo = (e) => {
      const editorRect = views.editor.getBoundingClientRect();
      // Finger near a side edge: stand upright there. Well away from both
      // sides: lie flat. (The gap between the two stops it flickering.)
      const fromLeft = e.clientX - editorRect.left;
      const fromRight = editorRect.right - e.clientX;
      const vertical = tools.toolbarVertical
        ? Math.min(fromLeft, fromRight) < EDGE_SNAP * 2.5
        : Math.min(fromLeft, fromRight) < EDGE_SNAP;
      if (vertical !== tools.toolbarVertical) {
        tools.toolbarVertical = vertical;
        bar.classList.toggle('vertical', vertical);
        grab = { x: 22, y: 18 }; // keep the finger on the grip end after the turn
      }
      const area = toolbarArea();
      const top = e.clientY - editorRect.top - grab.y;
      tools.toolbarPos = {
        // Upright, it sticks to whichever side it's nearer.
        x: vertical
          ? (e.clientX - editorRect.left < editorRect.width / 2 ? 0 : 1)
          : (area.freeW ? Math.min(1, Math.max(0, (e.clientX - editorRect.left - grab.x - area.left) / area.freeW)) : 0.5),
        y: area.freeH ? Math.min(1, Math.max(0, (top - area.top) / area.freeH)) : 0,
      };
      placeToolbar();
    };

    const onMove = (e) => {
      if (e.pointerId !== event.pointerId) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (!grab) {
        if (moved < 6) return;
        if (onControl) {
          clearTimeout(holdTimer); // moved before the hold finished: not a move
          stop();
          return;
        }
        begin();
      }
      e.preventDefault();
      moveTo(e);
    };

    const stop = () => {
      clearTimeout(holdTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    const onUp = (e) => {
      if (e.pointerId !== event.pointerId) return;
      const dragged = Boolean(grab);
      stop();
      if (!dragged) return;
      bar.classList.remove('dragging');
      saveTools();
      // Swallow the click that would otherwise press the button held to move.
      const swallow = (c) => { c.preventDefault(); c.stopPropagation(); };
      bar.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => bar.removeEventListener('click', swallow, { capture: true }), 0);
    };

    if (onControl) holdTimer = setTimeout(begin, HOLD_TO_MOVE);
    else event.preventDefault();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  // Keyboard: arrow keys nudge it.
  grip.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[event.key];
    if (!step) return;
    event.preventDefault();
    tools.toolbarPos = {
      x: Math.min(1, Math.max(0, tools.toolbarPos.x + step[0])),
      y: Math.min(1, Math.max(0, tools.toolbarPos.y + step[1])),
    };
    placeToolbar();
    saveTools();
  });
  $('toolbar-collapse').addEventListener('click', () => {
    tools.toolbarCompact = !tools.toolbarCompact;
    if (tools.toolbarCompact) closePopovers();
    saveTools();
    placeToolbar();
  });
  new ResizeObserver(placeToolbar).observe(views.editor);
}

function settingsButton() {
  const button = document.createElement('button');
  button.className = 'option icon-option gear-btn';
  button.setAttribute('aria-label', 'Ink settings');
  button.title = 'Ink settings';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
  button.classList.toggle('active', !$('pen-settings').hidden);
  button.addEventListener('click', togglePenSettings);
  return button;
}

// Eyedropper: the next tap on the page picks its colour, which becomes the
// current colour and a saved favourite. Works on pictures and PDFs too.
function eyedropperButton() {
  const button = document.createElement('button');
  button.className = 'option icon-option';
  button.setAttribute('aria-label', 'Pick a colour from the page');
  button.title = 'Eyedropper (I)';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5l5 5M17 7l-9.5 9.5L5 19l2.5-2.5"/><path d="M13 6l5 5"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L18 8l-2-2z"/></svg>';
  button.addEventListener('click', startEyedropper);
  return button;
}

function startEyedropper() {
  if (!editor) return;
  const key = colorToolKey();
  showToast('Tap anywhere on the page to pick its colour', true);
  editor.view.colorPick = (hex) => {
    if (key !== 'highlighter') addFavorite(hex);
    showToast(`Picked ${hex}`);
    pickColor(hex);
  };
}

function togglePenSettings() {
  const panel = $('pen-settings');
  const open = panel.hidden;
  closePopovers();
  panel.hidden = !open;
  renderPenSettings();
  renderToolbar();
  if (open) placeNextToToolbar(panel, document.querySelector('.gear-btn'));
}

function toggleStyleMenu() {
  const panel = $('style-menu');
  const open = panel.hidden;
  closePopovers();
  panel.hidden = !open;
  renderToolbar();
  if (open) placeNextToToolbar(panel, document.querySelector('.style-btn'));
}

function toggleColorMenu() {
  const panel = $('color-menu');
  const open = panel.hidden;
  closePopovers();
  panel.hidden = !open;
  renderToolbar();
  if (open) placeNextToToolbar(panel, document.querySelector('.color-btn'));
}

// Opens a panel by the floating toolbar, always fully on screen:
//   lying flat — below the toolbar, or above it when it's low down;
//   upright    — beside it (on the page side), level with the button tapped.
function placeNextToToolbar(panel, anchor) {
  const editorRect = views.editor.getBoundingClientRect();
  const header = views.editor.querySelector('.editor-bar').getBoundingClientRect();
  const bar = $('toolbar').getBoundingClientRect();
  const from = anchor?.getBoundingClientRect() ?? bar;
  const minTop = header.bottom - editorRect.top + 8;
  // Never taller than the space below the header; scrolls if it has to.
  panel.style.maxHeight = `${editorRect.height - minTop - 8}px`;
  const maxTop = editorRect.height - panel.offsetHeight - 8;
  const clampTop = (v) => Math.max(minTop, Math.min(v, maxTop));
  const clampLeft = (v) => Math.max(8, Math.min(v, editorRect.width - panel.offsetWidth - 8));

  if (tools.toolbarVertical) {
    const dockedLeft = bar.left - editorRect.left < editorRect.width / 2;
    panel.style.left = `${clampLeft(dockedLeft ? bar.right - editorRect.left + 8 : bar.left - editorRect.left - panel.offsetWidth - 8)}px`;
    panel.style.top = `${clampTop(from.top - editorRect.top - 20)}px`;
    return;
  }
  const below = bar.bottom - editorRect.top + 8;
  const fitsBelow = below + panel.offsetHeight < editorRect.height - 8;
  panel.style.top = `${clampTop(fitsBelow ? below : bar.top - editorRect.top - panel.offsetHeight - 8)}px`;
  panel.style.left = `${clampLeft(from.left - editorRect.left - 20)}px`;
}

// Sliders for the current pen style (or the highlighter). Values are 0–100 %.
function renderPenSettings() {
  const panel = $('pen-settings');
  if (panel.hidden) return;
  const isPen = tools.tool === 'pen';
  const style = tools.pen.style;
  const settings = isPen ? tools.penSettings[style] : tools.highlighter;
  $('pen-settings-title').textContent = isPen ? `${PEN_STYLES.find((s) => s.id === style).label} settings` : 'Highlighter settings';
  const rows = isPen
    ? [
      ['sens', 'Pressure sensitivity'],
      ['taper', 'Tip sharpness'],
      ...(style === 'fountain' ? [['flat', 'Tip flatness']] : []),
      ['stab', 'Stroke stabilization'],
    ]
    : [['stab', 'Stroke stabilization']];
  $('pen-settings-body').replaceChildren(...rows.map(([key, label]) => {
    const row = document.createElement('label');
    row.className = 'slider-row';
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.value = String(Math.round((settings[key] ?? 0) * 100));
    value.textContent = `${input.value}%`;
    input.addEventListener('input', () => {
      settings[key] = Number(input.value) / 100;
      value.textContent = `${input.value}%`;
      editor?.view.setTool(viewTool());
    });
    input.addEventListener('change', saveTools);
    row.append(name, value, input);
    return row;
  }));
}

function toggleRuler() {
  if (!editor) return;
  const show = !editor.view.ruler;
  editor.view.setRulerVisible(show);
  $('ruler-btn').setAttribute('aria-pressed', String(show));
}

// ---- Popovers ----

const popovers = [
  { button: $('paper-btn'), menu: $('paper-menu') },
  { button: $('more-btn'), menu: $('more-menu') },
  { button: $('library-more'), menu: $('library-menu') },
];

function togglePopover(target) {
  for (const p of popovers) {
    const open = p === target && p.menu.hidden;
    p.menu.hidden = !open;
    p.button.setAttribute('aria-expanded', String(open));
  }
  if (!target.menu.hidden && target.menu.id === 'paper-menu') renderPaperMenu();
  $('paste-menu').disabled = !clipboard;
}

function closePopovers() {
  for (const p of popovers) {
    p.menu.hidden = true;
    p.button.setAttribute('aria-expanded', 'false');
  }
  const panels = ['pen-settings', 'color-menu', 'style-menu', 'size-menu'].map($);
  if (panels.some((p) => !p.hidden)) {
    for (const p of panels) p.hidden = true;
    renderToolbar();
  }
}

function paperThumbnail(paper) {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 48 * dpr;
  canvas.height = 64 * dpr;
  const ctx = canvas.getContext('2d');
  const scale = (48 * dpr) / 768;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawPaper(ctx, paper, 768, 1024, 10);
  return canvas;
}

// Paper changes apply to the page currently in view.
function renderPaperMenu() {
  if (!editor || $('paper-menu').hidden) return;
  const page = currentPage();
  const paper = getPaper(page);
  const setPaper = (change) => edit(page.id, paperCommand(paper, { ...paper, ...change }));
  // Whiteboards have no page edges, so only patterns that tile endlessly.
  const templates = isWhiteboard(page)
    ? PAPER_TEMPLATES.filter((t) => ['blank', 'dotted', 'grid'].includes(t.id))
    : PAPER_TEMPLATES;

  $('paper-templates').replaceChildren(...templates.map((t) => {
    const button = document.createElement('button');
    button.className = 'template';
    button.setAttribute('aria-pressed', String(t.id === paper.template));
    button.append(paperThumbnail({ ...paper, template: t.id }), t.label);
    button.addEventListener('click', () => setPaper({ template: t.id }));
    return button;
  }));
  $('paper-colors').replaceChildren(...PAPER_COLORS.map((c) => {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.style.background = c.fill;
    button.title = c.label;
    button.setAttribute('aria-label', `${c.label} paper`);
    button.setAttribute('aria-pressed', String(c.id === paper.color));
    button.addEventListener('click', () => setPaper({ color: c.id }));
    return button;
  }));
}

// ---- Editor lifecycle ----

async function closeEditor() {
  if (!editor) return;
  commitText();
  const { view, saver } = editor;
  view.destroy();
  selectionBar.hidden = true;
  hidePasteBar();
  hideLoopBar();
  closePopovers();
  await saver.flush();
  editor = null;
  thumbCache.clear();
  $('ruler-btn').setAttribute('aria-pressed', 'false');
}

async function openEditor(docId, token) {
  const doc = await store.getDocument(docId);
  const pages = doc && await store.getPages(doc);
  if (token !== routeToken) return;
  if (!doc || !pages?.length) {
    showBanner('That notebook could not be found.');
    location.hash = '';
    return;
  }

  docTitle.textContent = doc.title;
  document.title = `${doc.title} — Inkwell`;
  saveStatus.textContent = STATUS_TEXT.saved;
  const whiteboard = isWhiteboard(pages[0]);
  views.editor.classList.toggle('is-whiteboard', whiteboard);
  showView('editor');

  const dirty = new Map();
  let retryTimer = null;
  // Saves every page edited since the last save, in one transaction. Pages
  // deleted meanwhile are skipped; on failure the batch is kept for retry.
  const saveDirty = async () => {
    const batch = new Map(dirty);
    dirty.clear();
    const live = [...batch.values()].filter((p) => editor?.pages.some((q) => q.id === p.id) ?? true);
    try {
      if (live.length) await store.savePages(doc.id, live);
    } catch (err) {
      for (const [id, page] of batch) if (!dirty.has(id)) dirty.set(id, page);
      throw err;
    }
  };
  const saver = createAutosaver(saveDirty, {
    onStatus: (status) => { saveStatus.textContent = STATUS_TEXT[status]; },
    onError: (err) => {
      console.error('Save failed', err);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => saver.schedule(true), 3000);
    },
  });
  const view = new DocumentView($('canvas-wrap'), {
    onCommand: edit,
    onUndo: undo,
    onRedo: redo,
    onSelectionChange: placeSelectionBar,
    onCurrentPageChange,
    onTextRequest: openTextEditor,
    onEmptyLassoTap,
    onLoopDrawn,
    // Whiteboards open at 100%; notebooks at the last zoom used.
    initialZoom: whiteboard ? 1 : tools.zoom,
    onZoomChange: (zoom) => {
      updateZoomIndicator(zoom);
      if (whiteboard) return;
      tools.zoom = Math.round(zoom * 100) / 100;
      clearTimeout(zoomSaveTimer);
      zoomSaveTimer = setTimeout(saveTools, 500);
    },
  });
  view.allowFinger = tools.allowFinger;
  view.gestures = tools.gestures;
  view.setMinimapVisible(tools.minimap);
  view.setTool(viewTool());
  editor = { doc, pages, view, saver, dirty, history: new History(), current: 0 };
  pagePanel.hidden = !tools.showPages || whiteboard;
  $('pages-btn').setAttribute('aria-pressed', String(tools.showPages));
  refreshEditor();
  onCurrentPageChange(0);
  updateZoomIndicator(view.zoom);
}

function updateZoomIndicator(zoom) {
  $('zoom-indicator').textContent = `${Math.round(zoom * 100)}%`;
}

// ---- Keyboard shortcuts ----

function handleKey(event) {
  if (!editor || document.querySelector('dialog[open]')) return;
  if (event.target === textEditor) {
    if (event.key === 'Escape') commitText();
    return;
  }
  if (event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') return;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  let handled = true;

  if (mod && key === 'z') event.shiftKey ? redo() : undo();
  else if (mod && key === 'y') redo();
  else if (mod && key === 'd') duplicateSelection();
  else if (mod && key === 'c') handled = copySelection();
  else if (mod && key === 'x') cutSelection();
  else if (mod && key === 'v') paste();
  else if (mod && key === 'e') exportPdf();
  else if (mod && event.shiftKey && key === 'n') addPage();
  else if (mod && (key === '=' || key === '+')) editor.view.zoomBy(1.25);
  else if (mod && key === '-') editor.view.zoomBy(0.8);
  else if (mod && key === '0') editor.view.fitWidth();
  else if (mod || event.altKey) handled = false;
  else if (TOOL_KEYS[key]) selectTool(TOOL_KEYS[key]);
  else if (key === 'r') toggleRuler();
  else if (key === 'i') startEyedropper();
  else if (key === '[') stepSize(-1);
  else if (key === ']') stepSize(1);
  else if (key === 'delete' || key === 'backspace') deleteSelection();
  else if (key === 'escape') { closePopovers(); hidePasteBar(); editor.view.setSelection(null, []); }
  else if (key === '?') $('shortcuts-dialog').showModal();
  else handled = false;

  if (handled) event.preventDefault();
}

// ---- Routing ----

async function route() {
  const token = ++routeToken;
  await closeEditor();
  if (token !== routeToken) return;
  const match = location.hash.match(/^#\/doc\/(.+)$/);
  try {
    if (match) {
      await openEditor(decodeURIComponent(match[1]), token);
    } else {
      document.title = 'Inkwell';
      showView('library');
      await renderLibrary();
    }
  } catch (err) {
    console.error(err);
    showBanner(`Something went wrong: ${err.message}`);
  }
}

// Save immediately when the app is hidden or closed (app switcher, Home, lock).
function flushNow() {
  commitText();
  return editor?.saver.flush();
}

// ---- Updates ----

// Only the published (https) app installs the offline service worker; the
// development copy on the PC always loads the latest files directly.
// A new version downloads in the background; "Update ready" appears, and the
// switch happens only when you tap Update (after saving your work).
function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:') {
    // Development copy: drop any offline worker from older versions so
    // edits always show up straight away.
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
    return;
  }
  const offerUpdate = (worker) => {
    $('update-banner').hidden = false;
    $('update-now').onclick = async () => {
      $('update-now').disabled = true;
      commitText();
      await editor?.saver.flush();
      worker.postMessage('apply-update');
    };
  };
  navigator.serviceWorker.register('sw.js').then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });
    // Look for a new version now and then while the app is open.
    setInterval(() => registration.update().catch(() => {}), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  }).catch((err) => console.warn('Service worker not registered', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  $('update-later').addEventListener('click', () => { $('update-banner').hidden = true; });
}

function on(id, type, fn) {
  $(id).addEventListener(type, (event) => {
    const result = fn(event);
    if (result instanceof Promise) result.catch((err) => showBanner(err.message));
  });
}

async function start() {
  try {
    store = await NoteStore.open(globalThis.indexedDB);
  } catch (err) {
    showBanner(`Notes storage is unavailable: ${err.message}`);
    return;
  }
  setAssetSource((id) => store.getAsset(id));

  // Redraw wherever a picture appears once it has loaded.
  let libraryRefresh = null;
  // Full-size pictures redraw the pages; small ones redraw only the thumbnails,
  // covers and minimap that show that picture.
  onAssetLoaded((assetId, size) => {
    if (editor) {
      if (size === 'full') {
        editor.view.invalidate();
        return;
      }
      editor.view.invalidateMinimap();
      for (const [pageId, cached] of thumbCache) {
        if (pageAssetIds(cached.page).includes(assetId)) thumbCache.delete(pageId);
      }
      schedulePagePanel();
    } else if (!views.library.hidden && size === 'thumb') {
      clearTimeout(libraryRefresh);
      libraryRefresh = setTimeout(renderLibrary, 150);
    }
  });

  // Ask the browser not to evict stored notes. iPadOS may still decline.
  navigator.storage?.persist?.().catch(() => {});

  // Library
  on('new-doc', 'click', newDocument);
  on('import-pdf', 'click', importPdf);
  on('new-folder', 'click', newFolder);
  on('backup', 'click', backupLibrary);
  on('backup-btn', 'click', backupLibrary);
  // From a notebook, save what's just been written before backing up.
  on('editor-backup-btn', 'click', async () => {
    await flushNow();
    return backupLibrary();
  });
  on('restore', 'click', restoreLibrary);
  on('empty-new-doc', 'click', newDocument);
  const cardAction = (id, fn) => on(id, 'click', () => {
    const doc = cardMenuDoc;
    closeCardMenu();
    return doc ? fn(doc) : undefined;
  });
  cardAction('card-rename', renameDocument);
  cardAction('card-move', moveDocument);
  cardAction('card-duplicate', duplicateDocument);
  cardAction('card-delete', deleteDocument);
  let searchTimer = null;
  on('search', 'input', () => {
    library.query = $('search').value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderLibrary, 120);
  });
  $('sort').value = tools.sort;
  on('sort', 'change', () => {
    tools.sort = $('sort').value;
    saveTools();
    return renderLibrary();
  });

  // Editor
  on('back', 'click', () => { location.hash = ''; });
  on('undo', 'click', undo);
  on('redo', 'click', redo);
  on('pages-btn', 'click', () => togglePagePanel());
  on('add-page-btn', 'click', addPage);
  on('panel-add-page', 'click', addPage);
  on('export-pdf', 'click', exportPdf);
  on('insert-image', 'click', insertImage);
  on('ruler-btn', 'click', toggleRuler);
  on('sel-copy', 'click', copySelection);
  on('sel-lock', 'click', lockSelection);
  on('unlock-all', 'click', unlockAll);
  on('loop-select', 'click', acceptLoop);
  on('zoom-indicator', 'click', () => editor?.view.resetView());
  const toggle = (id, get, set) => {
    $(id).checked = get();
    $(id).addEventListener('change', () => {
      set($(id).checked);
      saveTools();
    });
  };
  toggle('gesture-scribble', () => tools.gestures.scribble, (v) => { tools.gestures.scribble = v; });
  toggle('gesture-circle', () => tools.gestures.circle, (v) => { tools.gestures.circle = v; });
  toggle('gesture-double', () => tools.gestures.doubleTap, (v) => { tools.gestures.doubleTap = v; });
  toggle('minimap-toggle', () => tools.minimap, (v) => {
    tools.minimap = v;
    editor?.view.setMinimapVisible(v);
  });
  on('sel-delete', 'click', deleteSelection);
  on('sel-duplicate', 'click', duplicateSelection);
  on('paste-btn', 'click', () => pasteTarget && paste(pasteTarget.pageId, pasteTarget.x, pasteTarget.y));
  on('paste-menu', 'click', () => { closePopovers(); paste(); });
  on('show-shortcuts', 'click', () => { closePopovers(); $('shortcuts-dialog').showModal(); });
  for (const p of popovers) p.button.addEventListener('click', () => togglePopover(p));
  for (const button of document.querySelectorAll('.tool[data-tool]')) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }

  textEditor.addEventListener('input', autosizeTextEditor);
  textEditor.addEventListener('blur', () => setTimeout(commitText, 0));
  // The Done / Delete buttons must not take focus from the text box, or the
  // blur above would save it before the button is handled.
  $('text-bar').addEventListener('pointerdown', (event) => event.preventDefault());
  $('text-bar').addEventListener('mousedown', (event) => event.preventDefault());
  on('text-done', 'click', commitText);
  on('text-delete', 'click', deleteTextBox);
  // Touching the page while typing finishes the text box (the canvas blocks normal focus changes).
  $('canvas-wrap').addEventListener('pointerdown', (event) => {
    if (textSession && event.target !== textEditor && !$('text-bar').contains(event.target)) commitText();
    if (!pasteBar.contains(event.target)) hidePasteBar();
  }, true);

  fingerDraw.checked = tools.allowFinger;
  fingerDraw.addEventListener('change', () => {
    tools.allowFinger = fingerDraw.checked;
    saveTools();
    if (editor) editor.view.allowFinger = tools.allowFinger;
  });

  // Close popovers when tapping elsewhere.
  document.addEventListener('pointerdown', (event) => {
    const inside = popovers.some((p) => p.menu.contains(event.target) || p.button.contains(event.target))
      || ['pen-settings', 'color-menu', 'style-menu', 'size-menu'].some((id) => $(id).contains(event.target))
      || event.target.closest?.('.gear-btn, .color-btn, .style-btn, .size-more');
    if (!inside) closePopovers();
    if (!$('card-menu').contains(event.target) && !event.target.closest?.('.doc-more')) closeCardMenu();
  });
  document.addEventListener('keydown', handleKey);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('hashchange', route);

  setupUpdates();
  $('app-version').textContent = `Inkwell ${APP_VERSION}`;
  on('backup-now', 'click', backupLibrary);

  // Theme: the pickers in both ⋯ menus, and the canvas follows changes
  // (including the iPad switching between light and dark on Auto).
  applyTheme(loadTheme());
  const pickers = [...document.querySelectorAll('[data-theme-picker]')];
  for (const picker of pickers) renderThemePicker(picker);
  const themeChanged = () => {
    applyTheme(loadTheme());
    for (const picker of pickers) renderThemePicker(picker);
    editor?.view.refreshTheme();
  };
  onThemeChange(themeChanged);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);

  setupFloatingToolbar();
  renderToolbar();
  await route();
}

start();
