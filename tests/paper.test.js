import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_COLORS, PAPER_TEMPLATES, paperColor, paperLayout } from '../app/src/paper.js';
import { DEFAULT_PAPER, LEGACY_PAPER, createPage, getPaper } from '../app/src/model.js';

test('every template and color combination produces a layout', () => {
  for (const t of PAPER_TEMPLATES) {
    for (const c of PAPER_COLORS) {
      const layout = paperLayout({ template: t.id, color: c.id }, 768, 1024);
      assert.equal(layout.fill, c.fill);
    }
  }
});

test('blank paper has no lines or dots', () => {
  const layout = paperLayout({ template: 'blank', color: 'white' }, 768, 1024);
  assert.equal(layout.lines.length, 0);
  assert.equal(layout.dots.length, 0);
});

test('lined paper has evenly spaced rules and a margin line inside the page', () => {
  const { lines } = paperLayout({ template: 'lined', color: 'white' }, 768, 1024);
  const rules = lines.filter((l) => l.y1 === l.y2);
  assert.ok(rules.length > 20);
  assert.ok(rules.every((l, i) => i === 0 || l.y1 - rules[i - 1].y1 === 32));
  assert.ok(lines.every((l) => l.y1 >= 0 && l.y2 <= 1024 && l.x1 >= 0 && l.x2 <= 768));
  assert.equal(lines.filter((l) => l.x1 === l.x2).length, 1);
});

test('grid and dotted papers cover the page', () => {
  const grid = paperLayout({ template: 'grid', color: 'white' }, 768, 1024);
  assert.equal(grid.lines.filter((l) => l.x1 === l.x2).length, 31);
  const dotted = paperLayout({ template: 'dotted', color: 'white' }, 768, 1024);
  assert.equal(dotted.dots.length, 31 * 42);
});

test('cornell paper has a cue column and a summary area', () => {
  const { lines } = paperLayout({ template: 'cornell', color: 'cream' }, 768, 1024);
  assert.ok(lines.some((l) => l.x1 === 216 && l.x2 === 216));
  assert.ok(lines.some((l) => l.y1 === 1024 - 192 && l.x1 === 0));
});

test('unknown colors fall back to white', () => {
  assert.equal(paperColor('nope').id, 'white');
});

test('new pages get the default paper; older pages without one read as blank white', () => {
  assert.deepEqual(getPaper(createPage()), DEFAULT_PAPER);
  const legacy = createPage();
  delete legacy.paper;
  assert.deepEqual(getPaper(legacy), LEGACY_PAPER);
});
