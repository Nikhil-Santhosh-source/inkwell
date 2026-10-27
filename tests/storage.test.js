import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { NoteStore, openDatabase } from '../app/src/storage.js';
import { addStroke, createPage, createStroke } from '../app/src/model.js';

function clock(start = 1000) {
  let t = start;
  return () => t++;
}

async function freshStore(factory = new IDBFactory()) {
  return { factory, store: await NoteStore.open(factory, { now: clock() }) };
}

test('a created document and its page can be read back', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Lecture 1');
  const [listed] = await store.listDocuments();
  assert.deepEqual(listed, doc);
  const page = await store.getPage(doc.pageIds[0]);
  assert.deepEqual(page.strokes, []);
});

test('documents are listed newest first', async () => {
  const { store } = await freshStore();
  const a = await store.createDocument('A');
  const b = await store.createDocument('B');
  assert.deepEqual((await store.listDocuments()).map((d) => d.id), [b.id, a.id]);
  await store.savePage(a.id, await store.getPage(a.pageIds[0]));
  assert.deepEqual((await store.listDocuments()).map((d) => d.id), [a.id, b.id]);
});

test('renaming updates the title and modified time', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Old');
  const renamed = await store.renameDocument(doc.id, '  New name ');
  assert.equal(renamed.title, 'New name');
  assert.ok(renamed.modifiedAt > doc.modifiedAt);
  assert.equal((await store.getDocument(doc.id)).title, 'New name');
});

test('renaming a missing document fails', async () => {
  const { store } = await freshStore();
  await assert.rejects(store.renameDocument('missing', 'x'), /not found/);
});

test('deleting removes the document and its pages, and leaves others alone', async () => {
  const { store } = await freshStore();
  const keep = await store.createDocument('Keep');
  const gone = await store.createDocument('Gone');
  await store.deleteDocument(gone.id);
  assert.equal(await store.getDocument(gone.id), null);
  assert.equal(await store.getPage(gone.pageIds[0]), null);
  assert.deepEqual((await store.listDocuments()).map((d) => d.id), [keep.id]);
  assert.ok(await store.getPage(keep.pageIds[0]));
});

test('saved strokes survive closing and reopening the database (relaunch)', async () => {
  const { factory, store } = await freshStore();
  const doc = await store.createDocument('Persist');
  let page = await store.getPage(doc.pageIds[0]);
  const stroke = createStroke([{ x: 10, y: 10, pressure: 0.4 }, { x: 50, y: 60, pressure: 0.8 }]);
  page = addStroke(page, stroke);
  await store.savePage(doc.id, page);
  store.close();

  const reopened = await NoteStore.open(factory);
  const [listed] = await reopened.listDocuments();
  assert.equal(listed.title, 'Persist');
  assert.deepEqual((await reopened.getPage(doc.pageIds[0])).strokes, [stroke]);
});

test('saving a page under the wrong document is rejected and changes nothing', async () => {
  const { store } = await freshStore();
  const a = await store.createDocument('A');
  const b = await store.createDocument('B');
  const pageA = addStroke(await store.getPage(a.pageIds[0]), createStroke([{ x: 1, y: 1 }]));
  const bBefore = await store.getDocument(b.id);
  await assert.rejects(store.savePage(b.id, pageA), /does not belong/);
  assert.deepEqual(await store.getDocument(b.id), bBefore);
  assert.deepEqual((await store.getPage(a.pageIds[0])).strokes, []);
});

test('saving into a deleted document fails without leaving an orphan page', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Doomed');
  const page = await store.getPage(doc.pageIds[0]);
  await store.deleteDocument(doc.id);
  await assert.rejects(store.savePage(doc.id, page), /not found/);
  assert.equal(await store.getPage(page.id), null);
});

test('records in an unknown format version are refused, not silently used', async () => {
  const factory = new IDBFactory();
  const store = await NoteStore.open(factory);
  const doc = await store.createDocument('Future');
  store.close();

  const db = await openDatabase(factory);
  await new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    tx.objectStore('documents').put({ ...doc, schemaVersion: 2 });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();

  const reopened = await NoteStore.open(factory);
  await assert.rejects(reopened.listDocuments(), /Unsupported document format version 2/);
});

// ---- Multiple pages ----

test('pages can be inserted at a position and read back in order', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Pages');
  const [first] = await store.getPages(doc);
  const last = createPage();
  const middle = createPage();
  await store.insertPage(doc.id, last, 1);
  const updated = await store.insertPage(doc.id, middle, 1);
  assert.deepEqual(updated.pageIds, [first.id, middle.id, last.id]);
  assert.deepEqual((await store.getPages(updated)).map((p) => p.id), [first.id, middle.id, last.id]);
});

test('pages can be moved, and the order survives reopening', async () => {
  const { factory, store } = await freshStore();
  const doc = await store.createDocument('Order');
  const [a] = await store.getPages(doc);
  const b = createPage();
  const c = createPage();
  await store.insertPage(doc.id, b, 1);
  await store.insertPage(doc.id, c, 2);
  await store.movePage(doc.id, c.id, 0);
  store.close();
  const reopened = await NoteStore.open(factory);
  assert.deepEqual((await reopened.getDocument(doc.id)).pageIds, [c.id, a.id, b.id]);
});

test('deleting a page removes its record; the last page cannot be deleted', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Delete');
  const [a] = await store.getPages(doc);
  const b = createPage();
  await store.insertPage(doc.id, b, 1);
  const updated = await store.deletePage(doc.id, a.id);
  assert.deepEqual(updated.pageIds, [b.id]);
  assert.equal(await store.getPage(a.id), null);
  await assert.rejects(store.deletePage(doc.id, b.id), /at least one page/);
  assert.ok(await store.getPage(b.id));
});

test('savePages writes several pages in one go and rejects foreign pages', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Batch');
  const [a] = await store.getPages(doc);
  const b = createPage();
  await store.insertPage(doc.id, b, 1);
  const s = createStroke([{ x: 1, y: 1 }]);
  await store.savePages(doc.id, [addStroke(a, s), addStroke(b, s)]);
  const pages = await store.getPages(await store.getDocument(doc.id));
  assert.deepEqual(pages.map((p) => p.strokes.length), [1, 1]);

  const other = await store.createDocument('Other');
  const [foreign] = await store.getPages(other);
  await assert.rejects(store.savePages(doc.id, [addStroke(a, s), foreign]), /does not belong/);
  // Nothing from the rejected batch was written.
  assert.equal((await store.getPage(a.id)).strokes.length, 1);
});

// ---- Page sizes, assets, folders, duplicate, backup ----

import { createImageItem } from '../app/src/model.js';
import { BACKUP_FORMAT } from '../app/src/storage.js';

const asset = (id = crypto.randomUUID()) => ({ id, mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3, id.length]), width: 4, height: 3 });

// A document whose one page has a PDF background and a picture.
async function docWithAssets(store, title = 'Assets') {
  const bg = asset();
  const pic = asset();
  const page = { ...createPage(undefined, 990), background: { assetId: bg.id }, items: [createImageItem({ x: 1, y: 2, width: 30, height: 20, assetId: pic.id })] };
  const doc = await store.createDocumentWithPages(title, [page], [bg, pic]);
  return { doc, page, bg, pic };
}

test('new notebooks can use a page size, paper and folder', async () => {
  const { store } = await freshStore();
  const doc = await store.createDocument('Sized', { height: 576, paper: { template: 'grid', color: 'cream' }, folderId: 'f1' });
  const [page] = await store.getPages(doc);
  assert.equal(page.height, 576);
  assert.deepEqual(page.paper, { template: 'grid', color: 'cream' });
  assert.equal(doc.folderId, 'f1');
});

test('assets are stored as bytes and read back intact', async () => {
  const { store } = await freshStore();
  const a = asset('a1');
  await store.putAsset(a);
  assert.deepEqual(await store.getAsset('a1'), a);
  await assert.rejects(store.putAsset({ id: 'bad', mime: 'image/jpeg', bytes: 'nope' }), /malformed/);
});

test('deleting a notebook or a page also deletes its pictures', async () => {
  const { store } = await freshStore();
  const { doc, bg, pic } = await docWithAssets(store);
  assert.ok(await store.getAsset(bg.id));
  await store.deleteDocument(doc.id);
  assert.equal(await store.getAsset(bg.id), undefined);
  assert.equal(await store.getAsset(pic.id), undefined);

  const second = await docWithAssets(store, 'Second');
  await store.insertPage(second.doc.id, createPage(), 1);
  await store.deletePage(second.doc.id, second.page.id);
  assert.equal(await store.getAsset(second.pic.id), undefined);
});

test('duplicating a notebook copies pages, strokes and pictures under new ids', async () => {
  const { store } = await freshStore();
  const { doc, page, pic } = await docWithAssets(store, 'Original');
  await store.savePage(doc.id, addStroke(page, createStroke([{ x: 5, y: 5 }])));
  const copy = await store.duplicateDocument(doc.id);
  assert.equal(copy.title, 'Original copy');
  assert.notEqual(copy.pageIds[0], doc.pageIds[0]);
  const [copied] = await store.getPages(copy);
  assert.equal(copied.strokes.length, 1);
  assert.notEqual(copied.items[0].assetId, pic.id);
  assert.deepEqual((await store.getAsset(copied.items[0].assetId)).bytes, pic.bytes);
  // Deleting the original leaves the copy's pictures alone.
  await store.deleteDocument(doc.id);
  assert.ok(await store.getAsset(copied.items[0].assetId));
  assert.ok(await store.getAsset(copied.background.assetId));
});

test('folders can be created, renamed, and deleted without deleting notebooks', async () => {
  const { store } = await freshStore();
  const folder = await store.createFolder('  Physics ');
  assert.equal(folder.name, 'Physics');
  const doc = await store.createDocument('Lecture');
  await store.moveDocument(doc.id, folder.id);
  assert.equal((await store.getDocument(doc.id)).folderId, folder.id);
  await store.renameFolder(folder.id, 'Science');
  assert.deepEqual((await store.listFolders()).map((f) => f.name), ['Science']);
  await store.deleteFolder(folder.id);
  assert.deepEqual(await store.listFolders(), []);
  assert.equal((await store.getDocument(doc.id)).folderId, null);
});

test('a backup restores into a fresh library with everything intact', async () => {
  const { store } = await freshStore();
  const folder = await store.createFolder('School');
  const { doc, pic } = await docWithAssets(store, 'Backed up');
  await store.moveDocument(doc.id, folder.id);
  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));
  assert.equal(backup.format, BACKUP_FORMAT);

  const { store: other } = await freshStore();
  const result = await other.importBackup(backup);
  assert.deepEqual(result, { documents: 1, pages: 1 });
  const [restored] = await other.listDocuments();
  assert.equal(restored.title, 'Backed up');
  const [folderCopy] = await other.listFolders();
  assert.equal(folderCopy.name, 'School');
  assert.equal(restored.folderId, folderCopy.id);
  const [page] = await other.getPages(restored);
  assert.equal(page.height, 990);
  assert.deepEqual((await other.getAsset(page.items[0].assetId)).bytes, pic.bytes);
  assert.ok(await other.getAsset(page.background.assetId));
});

test('restoring never overwrites: the same backup twice gives two copies, folders merge by name', async () => {
  const { store } = await freshStore();
  await store.createFolder('School');
  await store.createDocument('One');
  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));
  await store.importBackup(backup);
  assert.equal((await store.listDocuments()).length, 2);
  assert.equal((await store.listFolders()).length, 1);
});

test('files that are not backups are refused', async () => {
  const { store } = await freshStore();
  await assert.rejects(store.importBackup({ hello: 'world' }), /not an Inkwell backup/);
  assert.equal((await store.listDocuments()).length, 0);
});
