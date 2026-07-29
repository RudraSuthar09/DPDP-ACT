import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(dirname, 'dist');
const outfile = path.join(distDir, 'consent-sdk.min.js');

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [path.join(dirname, 'src', 'index.ts')],
  outfile,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
});

const code = readFileSync(outfile);
const integrity = 'sha384-' + createHash('sha384').update(code).digest('base64');
const { version } = JSON.parse(readFileSync(path.join(dirname, 'package.json'), 'utf8'));

writeFileSync(
  path.join(distDir, 'manifest.json'),
  JSON.stringify({ version, file: 'consent-sdk.min.js', integrity, sizeBytes: code.length }, null, 2) + '\n',
);

console.log(`consent-sdk: built ${outfile} (${code.length} bytes raw)`);
