// FR-CON-09: hard gate, not a target to eyeball. Fails the build (and CI,
// since turbo runs every workspace package's `build` script) if the SDK's
// gzipped bundle exceeds 5KB.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_BYTES = 5 * 1024;
const file = path.join(dirname, 'dist', 'consent-sdk.min.js');

const code = readFileSync(file);
const gzipBytes = gzipSync(code).length;

console.log(
  `consent-sdk: ${code.length} bytes raw, ${gzipBytes} bytes gzip (budget: ${BUDGET_BYTES} bytes gzip)`,
);

if (gzipBytes > BUDGET_BYTES) {
  console.error(
    `FAIL: consent-sdk gzipped bundle is ${gzipBytes} bytes, over the ${BUDGET_BYTES}-byte ` +
      '(5KB) budget from FR-CON-09.',
  );
  process.exit(1);
}
