import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(dirname, 'dist');
mkdirSync(distDir, { recursive: true });

const { version } = JSON.parse(readFileSync(path.join(dirname, 'package.json'), 'utf8'));

async function buildBundle(entry, outfileName, manifestName) {
  const outfile = path.join(distDir, outfileName);
  await build({
    entryPoints: [path.join(dirname, 'src', entry)],
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
  writeFileSync(
    path.join(distDir, manifestName),
    JSON.stringify({ version, file: outfileName, integrity, sizeBytes: code.length }, null, 2) + '\n',
  );
  console.log(`${entry}: built ${outfile} (${code.length} bytes raw)`);
}

// The grant/withdraw SDK — every site embedding it pays this cost (5KB budget).
await buildBundle('index.ts', 'consent-sdk.min.js', 'manifest.json');
// The consent FORM widget — a separate, larger bundle (it renders a UI), only
// paid by a site that opts into the pre-built form rather than the hosted link.
await buildBundle('form-widget.ts', 'consent-form-widget.min.js', 'form-widget-manifest.json');
