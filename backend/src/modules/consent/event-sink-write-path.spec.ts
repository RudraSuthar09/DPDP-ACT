import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * R3, enforced by the build, for Seam S2: "Never write an ad-hoc INSERT into
 * consent... tables. Everything goes through the sink (S2)." This is the same
 * guard the audit log has — the fast one, that fails in the PR with a message
 * telling you what to do instead, before a second write path is built around.
 *
 * The other two barriers are stronger but invisible at review time:
 *   - Nest: ConsentModule does not export EVENT_SINK, so injecting it elsewhere
 *     fails at boot.
 *   - Postgres: dpdp_app has no INSERT on consent_events, so raw SQL gets
 *     `permission denied` (the isolation suite pins that).
 */

const CONSENT_MODULE_DIR = join(__dirname);
const SRC_DIR = join(__dirname, '..', '..');

/** Identifiers no file outside the consent module may name. */
const RESERVED = ['consent_events', 'consent_append', 'EVENT_SINK'];

/** The subset that must still appear INSIDE the consent module, so the list is
 *  live and not guarding renamed-away ghosts. */
const MUST_BE_USED_BY_CONSENT_MODULE = ['consent_events', 'consent_append', 'EVENT_SINK'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' || name === 'dist' ? [] : walk(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('R3 — only the consent module may write consent events (Seam S2)', () => {
  const filesOutsideConsent = walk(SRC_DIR).filter(
    (f) => !f.startsWith(CONSENT_MODULE_DIR + sep),
  );

  it('finds files to check (the test is not passing vacuously)', () => {
    expect(filesOutsideConsent.length).toBeGreaterThan(15);
    expect(filesOutsideConsent.some((f) => f.includes('identity'))).toBe(true);
  });

  it.each(RESERVED)('no file outside src/modules/consent/ mentions %s', (identifier) => {
    const offenders = filesOutsideConsent
      .filter((file) => readFileSync(file, 'utf8').includes(identifier))
      .map((file) => relative(SRC_DIR, file));

    if (offenders.length > 0) {
      throw new Error(
        [
          '',
          '='.repeat(74),
          `  R3 VIOLATION: "${identifier}" is named outside the consent module.`,
          '',
          ...offenders.map((f) => `    src/${f.split(sep).join('/')}`),
          '',
          '  Consent events have exactly ONE writer: the PostgresEventSink, behind the',
          '  EventSink interface. A service that writes its own events can pick what to',
          '  record and what to omit — and the append-only log exists to remove exactly',
          '  that discretion.',
          '',
          '  To record a consent event, inject ConsentService and call recordConsent().',
          '  The event flows through the sink, and the database appends it.',
          '='.repeat(74),
          '',
        ].join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it.each(MUST_BE_USED_BY_CONSENT_MODULE)(
    'the consent module itself still uses %s (the rule is scoped, not cosmetic)',
    (identifier) => {
      const consentSources = walk(CONSENT_MODULE_DIR)
        .filter((f) => !f.endsWith('.spec.ts'))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      expect(consentSources).toContain(identifier);
    },
  );
});
