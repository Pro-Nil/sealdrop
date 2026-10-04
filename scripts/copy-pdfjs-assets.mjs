// Copies pdf.js font and wasm data into web/public so they are served from this origin.
import { cpSync, mkdirSync } from 'node:fs';
const src = 'node_modules/pdfjs-dist';
const dst = 'web/public/pdfjs';
mkdirSync(dst, { recursive: true });
for (const dir of ['standard_fonts', 'wasm']) cpSync(`${src}/${dir}`, `${dst}/${dir}`, { recursive: true });
console.log('pdf.js assets copied to', dst);
