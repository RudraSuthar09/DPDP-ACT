// FR-CON-09: hard gate, not a target to eyeball. Fails the build (and CI,
// since turbo runs every workspace package's `build` script) if the SDK's
// gzipped bundle exceeds 5KB.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

function check(name, file, budgetBytes) {
  const code = readFileSync(path.join(dirname, 'dist', file));
  const gzipBytes = gzipSync(code).length;
  console.log(`${name}: ${code.length} bytes raw, ${gzipBytes} bytes gzip (budget: ${budgetBytes} bytes gzip)`);
  if (gzipBytes > budgetBytes) {
    console.error(`FAIL: ${name} gzipped bundle is ${gzipBytes} bytes, over the ${budgetBytes}-byte budget.`);
    process.exit(1);
  }
}

// FR-CON-09's hard 5KB gate on the grant/withdraw SDK — every site embedding
// it pays this cost, so it stays tight regardless of what else this package grows.
check('consent-sdk', 'consent-sdk.min.js', 5 * 1024);
// The form widget renders an actual UI, so it earns a looser budget — still a
// hard gate, just not the same one, since only a site that opts into the
// pre-built form pays this cost.
check('consent-form-widget', 'consent-form-widget.min.js', 12 * 1024);
