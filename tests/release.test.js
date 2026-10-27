// Checks that guard the installed app: run before every publish (npm test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { APP_VERSION } from '../app/src/version.js';

const sw = readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8');

test('the offline worker and the app agree on the version', () => {
  const match = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(match, 'sw.js declares VERSION');
  assert.equal(match[1], APP_VERSION, 'bump VERSION in sw.js and APP_VERSION in src/version.js together');
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test('every app file is in the offline list, so the installed app works without Wi-Fi', () => {
  const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
  const sources = readdirSync(new URL('../app/src/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`);
  for (const file of [...sources, 'index.html', 'styles.css', 'manifest.webmanifest', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs']) {
    assert.ok(listed.has(file), `${file} is missing from SHELL in sw.js`);
  }
});

test('index.html only references files that exist', () => {
  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
    assert.doesNotThrow(() => readFileSync(new URL(`../app/${ref}`, import.meta.url)), `${ref} referenced by index.html`);
  }
});
