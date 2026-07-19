import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * R3, enforced by the build, for Seam S3: "Never write an ad-hoc INSERT into ...
 * workflow tables. Everything goes through the runner (S3)."
 *
 * Note the shape is subtly different from the audit/consent guards. The
 * WORKFLOW_RUNNER token is EXPORTED and injected by three modules — that sharing
 * is the whole point of the seam, so the token is NOT reserved. What is reserved
 * is direct access to the storage: workflow_jobs and the app.workflow_* write
 * functions may be named ONLY inside this module. Breach/Grievance/DPRequest
 * schedule through the interface; they never touch the table.
 */

const WORKFLOW_MODULE_DIR = join(__dirname);
const SRC_DIR = join(__dirname, '..', '..');

const RESERVED = [
  'workflow_jobs',
  'workflow_schedule',
  'workflow_cancel',
  'workflow_mark_fired',
  'workflow_mark_failed',
  'workflow_due_all',
];

const MUST_BE_USED_BY_WORKFLOW_MODULE = ['workflow_jobs', 'workflow_schedule', 'workflow_due_all'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' || name === 'dist' ? [] : walk(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('R3 — only the workflow module may write workflow_jobs (Seam S3)', () => {
  const filesOutsideWorkflow = walk(SRC_DIR).filter(
    (f) => !f.startsWith(WORKFLOW_MODULE_DIR + sep),
  );

  it('finds files to check (the test is not passing vacuously)', () => {
    expect(filesOutsideWorkflow.length).toBeGreaterThan(15);
    // The three modules that schedule deadlines exist and are being scanned.
    expect(filesOutsideWorkflow.some((f) => f.includes('breach'))).toBe(true);
    expect(filesOutsideWorkflow.some((f) => f.includes('grievance'))).toBe(true);
    expect(filesOutsideWorkflow.some((f) => f.includes('dprequest'))).toBe(true);
  });

  it.each(RESERVED)('no file outside src/modules/workflow/ mentions %s', (identifier) => {
    const offenders = filesOutsideWorkflow
      .filter((file) => readFileSync(file, 'utf8').includes(identifier))
      .map((file) => relative(SRC_DIR, file));

    if (offenders.length > 0) {
      throw new Error(
        [
          '',
          '='.repeat(74),
          `  R3 VIOLATION: "${identifier}" is named outside the workflow module.`,
          '',
          ...offenders.map((f) => `    src/${f.split(sep).join('/')}`),
          '',
          '  Deadlines have exactly ONE scheduler: the WorkflowRunner (S3). A module',
          '  that writes workflow_jobs directly is how deadline logic metastasises into',
          '  `if (status === "X" && daysSince > 3)` across controllers — the exact thing',
          '  the seam exists to prevent, and the reason Temporal could never be adopted',
          '  later without a rewrite.',
          '',
          '  To schedule or cancel a deadline, inject WORKFLOW_RUNNER and call',
          '  runner.schedule({ workflowId, kind, runAt, payload }) / runner.cancel(id).',
          '='.repeat(74),
          '',
        ].join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it.each(MUST_BE_USED_BY_WORKFLOW_MODULE)(
    'the workflow module itself still uses %s (the rule is scoped, not cosmetic)',
    (identifier) => {
      const workflowSources = walk(WORKFLOW_MODULE_DIR)
        .filter((f) => !f.endsWith('.spec.ts'))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      expect(workflowSources).toContain(identifier);
    },
  );
});
