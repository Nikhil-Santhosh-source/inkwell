// Copies third-party browser files from node_modules into app/vendor,
// so the app runs offline with no CDN. Usage: node scripts/vendor.mjs

import { copyFileSync, mkdirSync } from 'node:fs';

const FILES = [
  ['node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'app/vendor/pdf.min.mjs'],
  ['node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'app/vendor/pdf.worker.min.mjs'],
  ['node_modules/pdfjs-dist/LICENSE', 'app/vendor/pdfjs-LICENSE.txt'],
];

mkdirSync(new URL('../app/vendor/', import.meta.url), { recursive: true });
for (const [from, to] of FILES) {
  copyFileSync(new URL(`../${from}`, import.meta.url), new URL(`../${to}`, import.meta.url));
  console.log(`copied ${to}`);
}
