// IndexedDB persistence. Every multi-record change runs in one transaction,
// so a crash leaves either the old state or the new one, never a mix.
//
// Stores: documents, pages, folders, and assets (image bytes for inserted
// pictures and imported PDF pages; each belongs to exactly one page).

import {
  SCHEMA_VERSION, createDocument, newId, normalizeTitle, pageAssetIds, validateDocument, validatePage,
} from './model.js';
import { base64ToBytes, bytesToBase64 } from './util.js';

const DB_NAME = 'inkwell';
const DB_VERSION = 2;
const STORES = ['documents', 'pages', 'folders', 'assets'];
export const BACKUP_FORMAT = 'inkwell-backup';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// Runs work(stores) in one transaction; aborts it if work throws.
async function inTransaction(db, storeNames, mode, work) {
  const tx = db.transaction(storeNames, mode);
  const done = transactionDone(tx);
  const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
  let result;
  try {
    result = await work(stores);
  } catch (err) {
    try { tx.abort(); } catch { /* already finished */ }
    done.catch(() => {});
    throw err;
  }
  await done;
  return result;
}

export function openDatabase(idbFactory = globalThis.indexedDB, name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = idbFactory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Storage is in use by another tab'));
  });
}

function validateAsset(asset) {
  if (!asset || typeof asset.id !== 'string' || !(asset.bytes instanceof Uint8Array) || typeof asset.mime !== 'string') {
    throw new Error('Asset record is malformed');
  }
  return asset;
}

export class NoteStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  static async open(idbFactory, options) {
    return new NoteStore(await openDatabase(idbFactory, options?.name), options);
  }

  close() {
    this.db.close();
  }

  // ---- Documents ----

  // Newest first.
  async listDocuments() {
    const docs = await inTransaction(this.db, ['documents'], 'readonly', ({ documents }) =>
      requestResult(documents.getAll()));
    return docs.map(validateDocument).sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async getDocument(id) {
    const doc = await inTransaction(this.db, ['documents'], 'readonly', ({ documents }) =>
      requestResult(documents.get(id)));
    return doc ? validateDocument(doc) : null;
  }

  // options: { paper, height, folderId }
  async createDocument(title, options = {}) {
    const { doc, pages: newPages } = createDocument(title, this.now(), options);
    await inTransaction(this.db, ['documents', 'pages'], 'readwrite', async ({ documents, pages }) => {
      for (const page of newPages) pages.put(page);
      await requestResult(documents.put(doc));
    });
    return doc;
  }

  // Creates a document from ready-made pages and their assets (PDF import).
  async createDocumentWithPages(title, pageList, assetList = [], folderId = null) {
    pageList.forEach(validatePage);
    assetList.forEach(validateAsset);
    const now = this.now();
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      title: normalizeTitle(title),
      createdAt: now,
      modifiedAt: now,
      folderId,
      pageIds: pageList.map((p) => p.id),
    };
    await inTransaction(this.db, ['documents', 'pages', 'assets'], 'readwrite', async ({ documents, pages, assets }) => {
      for (const asset of assetList) assets.put(asset);
      for (const page of pageList) pages.put(page);
      await requestResult(documents.put(doc));
    });
    return doc;
  }

  async renameDocument(id, title) {
    return this.updateDocument(id, (doc) => ({ ...doc, title: normalizeTitle(title) }));
  }

  async moveDocument(id, folderId) {
    return this.updateDocument(id, (doc) => ({ ...doc, folderId: folderId ?? null }));
  }

  async updateDocument(id, change) {
    return inTransaction(this.db, ['documents'], 'readwrite', async ({ documents }) => {
      const doc = await requestResult(documents.get(id));
      if (!doc) throw new Error('Document not found');
      const updated = { ...change(validateDocument(doc)), modifiedAt: this.now() };
      await requestResult(documents.put(updated));
      return updated;
    });
  }

  // Removes the document with all of its pages and their assets together.
  async deleteDocument(id) {
    await inTransaction(this.db, ['documents', 'pages', 'assets'], 'readwrite', async ({ documents, pages, assets }) => {
      const doc = await requestResult(documents.get(id));
      if (!doc) return;
      for (const pageId of doc.pageIds) {
        const page = await requestResult(pages.get(pageId));
        if (page) for (const assetId of pageAssetIds(page)) assets.delete(assetId);
        pages.delete(pageId);
      }
      await requestResult(documents.delete(id));
    });
  }

  // Copies a document, its pages and their assets under new ids.
  async duplicateDocument(id) {
    return inTransaction(this.db, ['documents', 'pages', 'assets'], 'readwrite', async ({ documents, pages, assets }) => {
      const doc = await requestResult(documents.get(id));
      if (!doc) throw new Error('Document not found');
      const copyIds = [];
      for (const pageId of doc.pageIds) {
        const page = await requestResult(pages.get(pageId));
        if (!page) continue;
        const copy = await copyPageWithAssets(page, (assetId) => requestResult(assets.get(assetId)), assets);
        pages.put(copy);
        copyIds.push(copy.id);
      }
      const now = this.now();
      const duplicate = {
        ...doc, id: newId(), title: normalizeTitle(`${doc.title} copy`), createdAt: now, modifiedAt: now, pageIds: copyIds,
      };
      await requestResult(documents.put(duplicate));
      return duplicate;
    });
  }

  // ---- Pages ----

  async getPage(id) {
    const page = await inTransaction(this.db, ['pages'], 'readonly', ({ pages }) =>
      requestResult(pages.get(id)));
    return page ? validatePage(page) : null;
  }

  // A document's pages, in order.
  async getPages(doc) {
    const found = await inTransaction(this.db, ['pages'], 'readonly', ({ pages }) =>
      Promise.all(doc.pageIds.map((id) => requestResult(pages.get(id)))));
    return found.map(validatePage);
  }

  async savePage(docId, page) {
    await this.savePages(docId, [page]);
  }

  // Saves pages and bumps the document's modifiedAt in the same transaction.
  async savePages(docId, pageList) {
    pageList.forEach(validatePage);
    await inTransaction(this.db, ['documents', 'pages'], 'readwrite', async ({ documents, pages }) => {
      const doc = await requestResult(documents.get(docId));
      if (!doc) throw new Error('Document not found');
      if (pageList.some((page) => !doc.pageIds.includes(page.id))) {
        throw new Error('Page does not belong to this document');
      }
      for (const page of pageList) pages.put(page);
      await requestResult(documents.put({ ...doc, modifiedAt: this.now() }));
    });
  }

  // Inserts a new page at index; returns the updated document.
  async insertPage(docId, page, index) {
    validatePage(page);
    return this.updatePageOrder(docId, (doc, pages) => {
      if (doc.pageIds.includes(page.id)) throw new Error('Page already exists');
      pages.put(page);
      const pageIds = doc.pageIds.slice();
      pageIds.splice(Math.max(0, Math.min(index, pageIds.length)), 0, page.id);
      return pageIds;
    });
  }

  // Deletes a page and its assets; a document always keeps at least one page.
  async deletePage(docId, pageId) {
    return inTransaction(this.db, ['documents', 'pages', 'assets'], 'readwrite', async ({ documents, pages, assets }) => {
      const doc = await requestResult(documents.get(docId));
      if (!doc) throw new Error('Document not found');
      if (!doc.pageIds.includes(pageId)) throw new Error('Page does not belong to this document');
      if (doc.pageIds.length === 1) throw new Error('A notebook needs at least one page');
      const page = await requestResult(pages.get(pageId));
      if (page) for (const assetId of pageAssetIds(page)) assets.delete(assetId);
      pages.delete(pageId);
      const updated = { ...doc, pageIds: doc.pageIds.filter((id) => id !== pageId), modifiedAt: this.now() };
      await requestResult(documents.put(updated));
      return updated;
    });
  }

  async movePage(docId, pageId, toIndex) {
    return this.updatePageOrder(docId, (doc) => {
      const pageIds = doc.pageIds.filter((id) => id !== pageId);
      if (pageIds.length === doc.pageIds.length) throw new Error('Page does not belong to this document');
      pageIds.splice(Math.max(0, Math.min(toIndex, pageIds.length)), 0, pageId);
      return pageIds;
    });
  }

  async updatePageOrder(docId, change) {
    return inTransaction(this.db, ['documents', 'pages'], 'readwrite', async ({ documents, pages }) => {
      const doc = await requestResult(documents.get(docId));
      if (!doc) throw new Error('Document not found');
      const updated = { ...validateDocument(doc), pageIds: change(doc, pages), modifiedAt: this.now() };
      await requestResult(documents.put(updated));
      return updated;
    });
  }

  // ---- Assets ----

  async putAsset(asset) {
    validateAsset(asset);
    await inTransaction(this.db, ['assets'], 'readwrite', ({ assets }) => requestResult(assets.put(asset)));
    return asset;
  }

  async getAsset(id) {
    return inTransaction(this.db, ['assets'], 'readonly', ({ assets }) => requestResult(assets.get(id)));
  }

  // ---- Folders ----

  async listFolders() {
    const folders = await inTransaction(this.db, ['folders'], 'readonly', ({ folders: store }) =>
      requestResult(store.getAll()));
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createFolder(name) {
    const folder = { id: newId(), name: normalizeTitle(name), createdAt: this.now() };
    await inTransaction(this.db, ['folders'], 'readwrite', ({ folders }) => requestResult(folders.put(folder)));
    return folder;
  }

  async renameFolder(id, name) {
    return inTransaction(this.db, ['folders'], 'readwrite', async ({ folders }) => {
      const folder = await requestResult(folders.get(id));
      if (!folder) throw new Error('Folder not found');
      const updated = { ...folder, name: normalizeTitle(name) };
      await requestResult(folders.put(updated));
      return updated;
    });
  }

  // Deletes a folder; its notebooks move back to "All notebooks", not deleted.
  async deleteFolder(id) {
    await inTransaction(this.db, ['folders', 'documents'], 'readwrite', async ({ folders, documents }) => {
      const docs = await requestResult(documents.getAll());
      for (const doc of docs) if (doc.folderId === id) documents.put({ ...doc, folderId: null });
      await requestResult(folders.delete(id));
    });
  }

  // ---- Backup ----

  // The whole library as one JSON-serializable object (asset bytes as base64).
  async exportBackup() {
    const data = await inTransaction(this.db, STORES, 'readonly', async (stores) => ({
      documents: await requestResult(stores.documents.getAll()),
      pages: await requestResult(stores.pages.getAll()),
      folders: await requestResult(stores.folders.getAll()),
      assets: await requestResult(stores.assets.getAll()),
    }));
    return {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      folders: data.folders,
      documents: data.documents,
      pages: data.pages,
      assets: data.assets.map((a) => ({ ...a, bytes: bytesToBase64(a.bytes) })),
    };
  }

  // Adds everything in a backup alongside the existing library, under new
  // ids, so restoring never overwrites current notes. Folders with the same
  // name are merged. Returns counts of what was added.
  async importBackup(backup) {
    if (backup?.format !== BACKUP_FORMAT || backup.version !== 1) throw new Error('This file is not an Inkwell backup');
    const docs = (backup.documents ?? []).map(validateDocument);
    const pageById = new Map((backup.pages ?? []).map((p) => [p.id, validatePage(p)]));
    const assetById = new Map((backup.assets ?? []).map((a) => [a.id, a]));

    return inTransaction(this.db, STORES, 'readwrite', async ({ documents, pages, folders, assets }) => {
      const existingFolders = await requestResult(folders.getAll());
      const folderIdMap = new Map();
      for (const folder of backup.folders ?? []) {
        const match = existingFolders.find((f) => f.name === folder.name);
        if (match) {
          folderIdMap.set(folder.id, match.id);
        } else {
          const created = { id: newId(), name: normalizeTitle(folder.name), createdAt: this.now() };
          folders.put(created);
          existingFolders.push(created);
          folderIdMap.set(folder.id, created.id);
        }
      }

      const restoreAsset = async (id) => {
        const a = assetById.get(id);
        return a ? validateAsset({ ...a, bytes: base64ToBytes(a.bytes) }) : undefined;
      };
      let pageCount = 0;
      for (const doc of docs) {
        const pageIds = [];
        for (const pageId of doc.pageIds) {
          const page = pageById.get(pageId);
          if (!page) continue;
          const copy = await copyPageWithAssets(page, restoreAsset, assets);
          pages.put(copy);
          pageIds.push(copy.id);
          pageCount++;
        }
        if (!pageIds.length) continue;
        documents.put({ ...doc, id: newId(), folderId: folderIdMap.get(doc.folderId) ?? null, pageIds });
      }
      return { documents: docs.length, pages: pageCount };
    });
  }
}

// Copies a page under a new id, copying its assets (looked up with
// getAsset(id)) into the `target` store under new ids too.
async function copyPageWithAssets(page, getAsset, target) {
  const remap = new Map();
  for (const assetId of pageAssetIds(page)) {
    const asset = await getAsset(assetId);
    if (!asset) continue;
    const copy = { ...asset, id: newId() };
    target.put(copy);
    remap.set(assetId, copy.id);
  }
  const copy = { ...page, id: newId() };
  if (page.items) {
    copy.items = page.items.map((item) => (item.type === 'image' && remap.has(item.assetId)
      ? { ...item, id: newId(), assetId: remap.get(item.assetId) }
      : { ...item, id: newId() }));
  }
  if (page.background?.assetId && remap.has(page.background.assetId)) {
    copy.background = { ...page.background, assetId: remap.get(page.background.assetId) };
  }
  copy.strokes = page.strokes.map((s) => ({ ...s, id: newId() }));
  return copy;
}
