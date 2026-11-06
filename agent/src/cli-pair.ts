/**
 * The one-shot CLI the Gateway Setup wizard's ELEVATED helper
 * (gateway-installer/service/elevated-helper.ps1) runs. It only ever WRITES
 * hand-off files into the protected state directory; the long-running
 * service consumes them under its own Windows identity on its next start.
 * It never reads the device credential or sources.json (both are
 * DPAPI-encrypted under the service account, which this process is not),
 * never calls the DPDP backend, and never starts the HTTP server.
 *
 * Usage (always via the vendored runtime):
 *   node dist/cli-pair.js pair --stdin        stdin: {"enrollmentCode","controlPlaneUrl","displayName"?}
 *   node dist/cli-pair.js add-source --stdin  stdin: one GatewaySourceConfig object
 *   node dist/cli-pair.js authorize-folder --stdin
 *                                             stdin: {"root","access","label"?} — queues a
 *                                             folder the administrator approved; the service
 *                                             gets its DPDP ids on its next start
 *   node dist/cli-pair.js remove              asks the service to de-enrol on its next start
 *
 * Secrets (enrolment codes, database passwords) are accepted ONLY on stdin.
 * Command lines are visible to process listings and to Windows
 * process-creation auditing; stdin is not.
 *
 * Output: one JSON line on stdout on success, one JSON line on stderr plus a
 * non-zero exit code on failure. Never echoes an input value.
 */
import { resolveAgentConfig } from './config-resolve';
import { writeConfigFile } from './config-file';
import { clearPendingEnrollment, writeDeenrollRequest, writePendingEnrollment } from './pending-enrollment';
import { appendPendingSource } from './sources-file';
import { appendPendingAuthorization, type PendingFolderAuthorization } from './pending-authorizations';
import { hasPersistedCredentialFile } from './enrollment';
import type { GatewaySourceConfig } from './connectors/registry';

const MAX_STDIN_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

/** Production workspaces must be HTTPS. Plain HTTP is accepted only for a
 *  loopback host (local development backend). Returns the bare origin, so a
 *  path/query can never ride along into config.json. */
export function normalizeWorkspaceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliInputError('The workspace URL is not a valid URL.');
  }
  if (url.username || url.password) throw new CliInputError('The workspace URL must not contain credentials.');
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.origin;
  throw new CliInputError('The workspace URL must use https:// (http:// is allowed only for localhost).');
}

export interface PairActionInput {
  enrollmentCode: string;
  controlPlaneUrl: string;
  displayName?: string;
}

function parsePairInput(value: unknown): PairActionInput {
  if (typeof value !== 'object' || value === null) throw new CliInputError('Pairing input must be a JSON object.');
  const v = value as Record<string, unknown>;
  if (typeof v.enrollmentCode !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(v.enrollmentCode.trim())) {
    throw new CliInputError('The enrolment code is missing or malformed.');
  }
  if (typeof v.controlPlaneUrl !== 'string') throw new CliInputError('The workspace URL is missing.');
  const out: PairActionInput = { enrollmentCode: v.enrollmentCode.trim(), controlPlaneUrl: v.controlPlaneUrl };
  if (typeof v.displayName === 'string' && v.displayName.trim()) {
    if (v.displayName.trim().length > 100) throw new CliInputError('The device name is too long (max 100 characters).');
    out.displayName = v.displayName.trim();
  }
  return out;
}

export function runPairAction(
  input: PairActionInput,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const controlPlaneUrl = normalizeWorkspaceUrl(input.controlPlaneUrl);
  const { config, configFilePath, fileConfig } = resolveAgentConfig(env, platform);
  if (hasPersistedCredentialFile(config.stateDir)) {
    throw new CliInputError('This Gateway is already paired. Remove it first (Gateway Setup -> Remove Gateway), then pair again.');
  }
  // Merge, never replace: an administrator may already have set "proxy" and
  // "tls" (needed before pairing can even reach DPDP on such networks).
  writeConfigFile(configFilePath, { ...(fileConfig ?? {}), controlPlaneUrl });
  writePendingEnrollment(config.stateDir, {
    enrollmentCode: input.enrollmentCode,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
}

/** Queues one source for the service to merge (and encrypt) on its next
 *  start. Returns only a count — never echoes the entry back. */
export function runAddSourceAction(
  source: GatewaySourceConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { pendingCount: number } {
  const { config } = resolveAgentConfig(env, platform);
  return { pendingCount: appendPendingSource(config.stateDir, source) };
}

/**
 * Queues one folder an administrator approved in Gateway Setup. The SERVICE
 * exchanges it for DPDP's record ids on its next start (only it can decrypt
 * the device credential) — see startup-tasks.ts's applyPendingAuthorizations.
 * Nothing here contacts DPDP, and no id is invented locally.
 */
export function runAuthorizeFolderAction(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { pendingCount: number } {
  const { config } = resolveAgentConfig(env, platform);
  return { pendingCount: appendPendingAuthorization(config.stateDir, parseAuthorizeFolderInput(input)) };
}

/**
 * Drops a trailing separator ("D:\Exports\" -> "D:\Exports") so the same
 * folder picked twice is recognised as the same entry. A drive or UNC ROOT
 * keeps its separator: "D:\" must never become "D:", which Windows reads as
 * "the current directory on D:", a different (and relative) place.
 */
export function normalizeFolderRoot(root: string): string {
  const stripped = root.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(stripped)) return `${stripped}\\`; // drive root
  if (/^\\\\[^\\]+$/.test(stripped) || stripped === '' || stripped === '\\' || stripped === '/') return root; // UNC/host-only or bare root
  return stripped;
}

/** Validates the wizard's hand-off: an absolute folder, a label, a permission. */
export function parseAuthorizeFolderInput(input: unknown): PendingFolderAuthorization {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CliInputError('Input must be a JSON object.');
  }
  const obj = input as Record<string, unknown>;
  const root = normalizeFolderRoot(typeof obj.root === 'string' ? obj.root.trim() : '');
  if (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(root)) throw new CliInputError('A full folder path is required.');
  const access = obj.access;
  if (access !== 'read' && access !== 'write' && access !== 'both') {
    throw new CliInputError('access must be "read", "write" or "both".');
  }
  // The label defaults to the folder's own name — never the whole path, which
  // must not reach DPDP.
  const fallback = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const rawLabel = typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : fallback;
  const label = rawLabel.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 120);
  if (!label) throw new CliInputError('The folder has no usable name.');
  return { root, label, access };
}

/** Asks the service to de-enrol (it alone can read the device token) and
 *  drops any not-yet-redeemed pairing code. */
export function runRemoveAction(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  const { config } = resolveAgentConfig(env, platform);
  clearPendingEnrollment(config.stateDir);
  writeDeenrollRequest(config.stateDir);
}

/** Reads and parses stdin, size-capped. Exported for tests. */
export function parseStdinJson(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) throw new CliInputError('Input is too large.');
  try {
    // Windows tooling (.NET StreamWriter, PowerShell pipes) may add a UTF-8
    // byte-order mark at either end; it is never part of the JSON.
    return JSON.parse(raw.replace(/^\uFEFF/, '').replace(/\uFEFF\s*$/, ''));
  } catch {
    throw new CliInputError('Input on stdin must be valid JSON.');
  }
}

// --- CLI glue ------------------------------------------------------------

function fail(message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

function succeed(extra: Record<string, unknown> = {}): never {
  process.stdout.write(JSON.stringify({ ok: true, ...extra }) + '\n');
  process.exit(0);
}

/** Reads all of stdin as UTF-8, aborting past the size cap. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        reject(new CliInputError('Input is too large.'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const [action, ...flags] = process.argv.slice(2);
  try {
    switch (action) {
      case 'pair':
      case 'add-source':
      case 'authorize-folder': {
        if (!flags.includes('--stdin')) return fail(`"${action}" reads its input from stdin only; pass --stdin.`);
        const input = parseStdinJson(await readStdin());
        if (action === 'pair') {
          runPairAction(parsePairInput(input));
          return succeed();
        }
        if (action === 'authorize-folder') return succeed(runAuthorizeFolderAction(input));
        return succeed(runAddSourceAction(input as GatewaySourceConfig));
      }
      case 'remove':
        runRemoveAction();
        return succeed();
      default:
        return fail(`Unknown action. Expected one of: pair, add-source, authorize-folder, remove.`);
    }
  } catch (err) {
    // Validation errors from this package never include input values (see
    // registry.ts / sources-file.ts / config-file.ts), so their message is
    // safe to surface; anything else is reported generically.
    const known = err instanceof Error && /^(CliInputError|SourcesFileError|AgentConfigError|Error)$/.test(err.name);
    fail(known ? (err as Error).message : 'The Gateway setup step failed.');
  }
}

if (require.main === module) {
  void main();
}

export const __test = { parsePairInput };
