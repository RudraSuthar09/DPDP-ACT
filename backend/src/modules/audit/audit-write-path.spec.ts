import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * R3, enforced by the build: "Never write an ad-hoc INSERT into consent, audit,
 * or workflow tables... One exception, once, and the seam is gone."
 *
 * The other two barriers are stronger but neither is visible at review time:
 *   - Nest: AuditModule does not export AUDIT_SINK, so injecting it elsewhere
 *     fails at boot (audit.module.spec.ts pins that).
 *   - Postgres: dpdp_app has no INSERT on audit_log, so raw SQL gets
 *     `permission denied` (audit-chain.isolation-spec.ts pins that).
 *
 * This test is the one that fails FAST, in the PR, with a message that explains
 * what to do instead — before someone has written a whole feature around a
 * second write path and is arguing to keep it.
 */

const AUDIT_MODULE_DIR = join(__dirname);
const SRC_DIR = join(__dirname, '..', '..');

/** Identifiers no file outside the audit module may name. */
const RESERVED = ['audit_log', 'audit_append', 'audit_chain_link', 'AUDIT_SINK'];

/**
 * The subset of RESERVED that must still appear INSIDE the audit module, to
 * prove the list is live. `audit_chain_link` is not among them: it is the chain
 * trigger, named only in the migration, and no TypeScript should ever call it —
 * it is on the reserved list precisely so that stays true.
 */
const MUST_BE_USED_BY_AUDIT_MODULE = ['audit_log', 'audit_append', 'AUDIT_SINK'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' || name === 'dist' ? [] : walk(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('R3 — only the audit module may write the audit log', () => {
  const filesOutsideAudit = walk(SRC_DIR).filter((f) => !f.startsWith(AUDIT_MODULE_DIR + sep));

  it('finds files to check (the test is not passing vacuously)', () => {
    // Without this, a broken walk() would make every assertion below trivially
    // true and the rule would quietly stop being enforced.
    expect(filesOutsideAudit.length).toBeGreaterThan(15);
    expect(filesOutsideAudit.some((f) => f.includes('identity'))).toBe(true);
  });

  it.each(RESERVED)('no file outside src/modules/audit/ mentions %s', (identifier) => {
    const offenders = filesOutsideAudit
      .filter((file) => readFileSync(file, 'utf8').includes(identifier))
      .map((file) => relative(SRC_DIR, file));

    if (offenders.length > 0) {
      throw new Error(
        [
          '',
          '='.repeat(74),
          `  R3 VIOLATION: "${identifier}" is named outside the audit module.`,
          '',
          ...offenders.map((f) => `    src/${f.split(sep).join('/')}`),
          '',
          '  The audit log has exactly ONE writer: the AuditInterceptor. A service',
          '  that writes its own entries can choose what to record and what to omit,',
          '  which is the whole property the hash chain exists to remove.',
          '',
          '  To record something from a service, ANNOTATE it instead:',
          '',
          '    constructor(private readonly audit: AuditContextService) {}',
          '    ...',
          '    this.audit.annotate({ targetType: "user", targetId: id,',
          '                          reason, beforeState, afterState });',
          '',
          '  The interceptor assembles and appends the entry, inside the same',
          '  transaction as your change, and the database chains it.',
          '='.repeat(74),
          '',
        ].join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it.each(MUST_BE_USED_BY_AUDIT_MODULE)(
    'the audit module itself still uses %s (the rule is scoped, not cosmetic)',
    (identifier) => {
      const auditSources = walk(AUDIT_MODULE_DIR)
        .filter((f) => !f.endsWith('.spec.ts'))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      // Proves these identifiers are real and still in use. Renaming the SQL
      // function without updating this list would otherwise leave a reserved
      // word nobody uses, and a test that guards nothing while staying green.
      expect(auditSources).toContain(identifier);
    },
  );
});
