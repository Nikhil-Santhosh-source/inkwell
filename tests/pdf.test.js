import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { addStroke, createPage, createStroke } from '../app/src/model.js';
import { buildPdf, hexToRgb, pageContent } from '../app/src/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

function samplePages() {
  const a = addStroke(
    addStroke(createPage({ template: 'lined', color: 'cream' }), createStroke(
      [{ x: 10, y: 10, pressure: 0.3 }, { x: 60, y: 40, pressure: 0.9 }, { x: 120, y: 20, pressure: 0.5 }],
      { tool: 'pen', color: '#1f5fd1', width: 2.5 },
    )),
    createStroke([{ x: 10, y: 100, pressure: 0.5 }, { x: 300, y: 100, pressure: 0.5 }], { tool: 'highlighter', color: '#ffd60a', width: 16 }),
  );
  const b = createPage({ template: 'dotted', color: 'dark' });
  return [a, b];
}

test('hexToRgb converts long and short hex colors', () => {
  assert.deepEqual(hexToRgb('#ffffff'), [1, 1, 1]);
  assert.deepEqual(hexToRgb('#f00'), [1, 0, 0]);
  assert.deepEqual(hexToRgb('nope'), [0, 0, 0]);
});

test('page content flips to page coordinates and draws paper, ink and translucent highlighter', () => {
  const content = pageContent(samplePages()[0]);
  assert.match(content, /^q\n0\.75 0 0 -0\.75 0 768 cm/);
  assert.match(content, /0 0 768 1024 re f/);
  assert.match(content, /0\.122 0\.373 0\.82 rg/); // pen blue
  assert.match(content, /q\n\/GSh gs\n1 0\.839 0\.039 rg/); // highlighter inside its own alpha state
  assert.ok(content.indexOf('/GSh gs') < content.indexOf('0.122 0.373 0.82 rg'), 'highlighter drawn before pen');
  assert.ok(content.trimEnd().endsWith('Q'));
});

test('buildPdf writes a structurally valid PDF with one page per notebook page', async () => {
  const bytes = await buildPdf(samplePages(), { title: 'Física — notes' });
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Type \/Pages \/Kids \[7 0 R 9 0 R\] \/Count 2/);
  assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 2);
  assert.match(text, /\/MediaBox \[0 0 576 768\]/);

  // Every xref entry points at the start of its object.
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.slice(startxref).startsWith('xref'));
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 10);
  entries.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));

  // Stream lengths match their data.
  for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream');
  }
  // Title as UTF-16BE: "F" "í" ...
  assert.match(text, /\/Title <FEFF004600ED/);
});

test('compressed streams use FlateDecode and inflate back to the same content', async () => {
  const pages = samplePages();
  const bytes = await buildPdf(pages, { compress: async (b) => new Uint8Array(deflateSync(b)) });
  const buf = Buffer.from(bytes);
  const text = latin1(bytes);
  assert.match(text, /\/Filter \/FlateDecode/);
  const m = /(\d+) 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(text);
  const start = m.index + m[0].length;
  const inflated = inflateSync(buf.subarray(start, start + Number(m[2]))).toString('utf8');
  assert.equal(inflated, pageContent(pages[0]));
  assert.ok(bytes.length < (await buildPdf(pages)).length);
});

// ---- Pictures, PDF pages, text, pen styles ----

import { createImageItem, createTextItem } from '../app/src/model.js';
import { pdfLatinString } from '../app/src/pdf.js';

// The smallest valid JPEG is not needed: the writer embeds bytes as given.
const fakeJpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 4, height: 3 };

test('pictures and PDF backgrounds are embedded once as JPEG images and drawn upright', async () => {
  const bg = { ...createPage({ template: 'blank', color: 'white' }, 990), background: { assetId: 'bg' } };
  const withImage = {
    ...createPage(),
    items: [createImageItem({ x: 100, y: 200, width: 300, height: 150, assetId: 'pic' })],
  };
  const reuse = { ...createPage(), items: [createImageItem({ x: 0, y: 0, width: 10, height: 10, assetId: 'pic' })] };
  const images = new Map([['bg', fakeJpeg], ['pic', fakeJpeg]]);
  const text = latin1(await buildPdf([bg, withImage, reuse], { images }));
  assert.equal((text.match(/\/Subtype \/Image/g) ?? []).length, 2, 'each asset embedded once');
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.match(text, /\/MediaBox \[0 0 576 742\.5\]/, 'page height follows the page');
  assert.match(text, /\/XObject << \/Im\d+ \d+ 0 R >>/);
  // Picture placed with a flipped image matrix at its box.
  assert.match(text, /q\n300 0 0 -150 100 350 cm\n\/Im\d+ Do\nQ/);
});

test('missing images are skipped rather than breaking the PDF', async () => {
  const page = { ...createPage(), items: [createImageItem({ x: 0, y: 0, width: 10, height: 10, assetId: 'gone' })] };
  const text = latin1(await buildPdf([page]));
  assert.ok(!text.includes('/Subtype /Image'));
  assert.ok(!text.includes(' Do\n'));
});

test('text boxes become Helvetica text, upright, one line per Tj', () => {
  const item = createTextItem({ x: 50, y: 60, width: 200, text: 'Hi (there)', size: 20, color: '#d12f2f', lines: ['Hi (there)', 'second'], height: 52 });
  const content = pageContent({ ...createPage(), items: [item] });
  assert.match(content, /BT\n\/F1 20 Tf\n1 0 0 -1 50 78 Tm\n\(Hi \\\(there\\\)\) Tj\n1 0 0 -1 50 104 Tm\n\(second\) Tj\nET/);
  assert.match(content, /0\.82 0\.184 0\.184 rg\nBT/);
});

test('text outside Latin-1 is replaced, Latin-1 accents are kept', () => {
  assert.equal(pdfLatinString('café'), '(caf\\351)');
  assert.equal(pdfLatinString('日本'), '(??)');
});

test('pencil strokes use the pencil transparency state', () => {
  const page = addStroke(createPage(), createStroke([{ x: 1, y: 1 }, { x: 50, y: 50 }], { tool: 'pen', style: 'pencil', color: '#000000', width: 2 }));
  assert.match(pageContent(page), /q\n\/GSp gs\n0 0 0 rg/);
});
