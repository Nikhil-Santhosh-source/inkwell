import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_HEIGHT, PAGE_WIDTH, SCHEMA_VERSION, addStroke, createDocument, createPage, createStroke,
  normalizeTitle, validateDocument, validatePage,
} from '../app/src/model.js';

test('createDocument makes a versioned document with one empty page', () => {
  const { doc, pages } = createDocument('  Physics  ', 1000);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.title, 'Physics');
  assert.equal(doc.createdAt, 1000);
  assert.equal(doc.modifiedAt, 1000);
  assert.equal(pages.length, 1);
  assert.deepEqual(doc.pageIds, [pages[0].id]);
  assert.deepEqual(pages[0].strokes, []);
  assert.equal(pages[0].width, PAGE_WIDTH);
  assert.equal(pages[0].height, PAGE_HEIGHT);
});

test('normalizeTitle trims, falls back to Untitled, and caps length', () => {
  assert.equal(normalizeTitle('   '), 'Untitled');
  assert.equal(normalizeTitle(null), 'Untitled');
  assert.equal(normalizeTitle('x'.repeat(500)).length, 200);
});

test('ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => createPage().id));
  assert.equal(ids.size, 200);
});

test('createStroke stores compact, rounded points clamped to the page', () => {
  const stroke = createStroke(
    [{ x: 10.123456, y: 20.987654, pressure: 0.33333 }, { x: -5, y: 5000, pressure: 2 }, { x: 1, y: 1 }],
    { color: '#000', width: 3 },
  );
  assert.equal(stroke.color, '#000');
  assert.equal(stroke.width, 3);
  assert.deepEqual(stroke.points, [[10.12, 20.99, 0.333], [0, PAGE_HEIGHT, 1], [1, 1, 0.5]]);
});

test('createStroke rejects empty or non-numeric points', () => {
  assert.throws(() => createStroke([]));
  assert.throws(() => createStroke([{ x: NaN, y: 1 }]));
});

test('addStroke returns a new page and leaves the original unchanged', () => {
  const page = createPage();
  const stroke = createStroke([{ x: 1, y: 2, pressure: 0.5 }]);
  const updated = addStroke(page, stroke);
  assert.equal(page.strokes.length, 0);
  assert.deepEqual(updated.strokes, [stroke]);
  assert.equal(updated.id, page.id);
});

test('strokes survive a JSON round trip unchanged', () => {
  const page = addStroke(createPage(), createStroke([{ x: 1, y: 2, pressure: 0.5 }, { x: 3, y: 4, pressure: 0.9 }]));
  assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
});

test('validators reject unknown versions and malformed records', () => {
  const { doc, pages } = createDocument('A');
  assert.equal(validateDocument(doc), doc);
  assert.equal(validatePage(pages[0]), pages[0]);
  assert.throws(() => validateDocument({ ...doc, schemaVersion: 99 }), /version 99/);
  assert.throws(() => validatePage({ ...pages[0], schemaVersion: 2 }), /version 2/);
  assert.throws(() => validateDocument({ ...doc, pageIds: 'nope' }), /malformed/);
  assert.throws(() => validatePage(undefined), /missing/);
});
