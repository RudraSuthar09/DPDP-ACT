import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkEnv } from './env.validation';

/**
 * The ECS templates in deploy/aws/ecs are configuration, but the properties
 * below are security and correctness rules, so they are tested like code:
 * a template edited into running two workers, or putting a secret in plain
 * environment, fails here instead of in production.
 */
const DIR = join(__dirname, '..', '..', '..', 'deploy', 'aws', 'ecs');
type Kv = { name: string; value?: string; valueFrom?: string };
interface TaskDef {
  family: string;
  executionRoleArn: string;
  taskRoleArn?: string;
  containerDefinitions: Array<{
    name: string;
    image: string;
    command?: string[];
    stopTimeout?: number;
    environment?: Kv[];
    secrets?: Kv[];
  }>;
}
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;
const task = (f: string) => load<TaskDef>(f).containerDefinitions[0]!;
const envOf = (f: string) =>
  Object.fromEntries((task(f).environment ?? []).map((e) => [e.name, e.value]));
const secretNames = (f: string) => (task(f).secrets ?? []).map((s) => s.name);

const SECRET_NAMES = [
  'APP_DATABASE_URL',
  'DATABASE_URL',
  'PGBOSS_DATABASE_URL',
  'JWT_SECRET',
  'REQUEST_OTP_SECRET',
  'MFA_SECRET_ENC_KEY',
  'SUBMISSION_STAGING_ENC_KEY',
  'POSTMARK_API_KEY',
  'MSG91_AUTH_KEY',
];

describe('exactly one worker', () => {
  const svc = load<{
    desiredCount: number;
    deploymentConfiguration: { minimumHealthyPercent: number; maximumPercent: number };
  }>('service-worker.json');

  it('the worker service runs ONE task', () => {
    expect(svc.desiredCount).toBe(1);
  });

  it('a deploy never runs the old and new worker side by side (stop first, then start)', () => {
    // maximumPercent 100 with one task means ECS must stop the old task before
    // it may start the new one. The database leadership lock covers anything
    // that bypasses this (a manual run-task, a second service).
    expect(svc.deploymentConfiguration).toMatchObject({
      minimumHealthyPercent: 0,
      maximumPercent: 100,
    });
  });

  it('only the worker task runs dist/worker.js', () => {
    for (const f of readdirSync(DIR).filter((n) => n.startsWith('task-def-'))) {
      const runsWorker = (task(f).command ?? []).join(' ').includes('dist/worker.js');
      expect({ f, runsWorker }).toEqual({ f, runsWorker: f === 'task-def-worker.json' });
    }
  });
});

describe('secrets', () => {
  it.each(readdirSync(DIR).filter((n) => n.startsWith('task-def-')))(
    '%s puts no secret in plain environment',
    (f) => {
      const plain = (task(f).environment ?? []).map((e) => e.name);
      expect(plain.filter((n) => SECRET_NAMES.includes(n))).toEqual([]);
      for (const s of task(f).secrets ?? [])
        expect(s.valueFrom).toMatch(/^arn:aws:secretsmanager:ap-south-1:/);
    },
  );

  it('least privilege per service', () => {
    // The API and worker never get the OWNER credential: pg-boss has its own role.
    expect(secretNames('task-def-api.json')).not.toContain('DATABASE_URL');
    expect(secretNames('task-def-worker.json')).not.toContain('DATABASE_URL');
    // The worker never gets the signing secret or the staging key.
    expect(secretNames('task-def-worker.json')).not.toEqual(expect.arrayContaining(['JWT_SECRET']));
    expect(secretNames('task-def-worker.json')).not.toContain('SUBMISSION_STAGING_ENC_KEY');
    // Only the migration task holds the owner credential, and nothing else.
    expect(secretNames('task-def-migrate.json')).toEqual(['DATABASE_URL']);
    // The frontend gets no secret at all.
    expect(task('task-def-frontend.json').secrets ?? []).toEqual([]);
  });
});

describe('production settings', () => {
  it('API and worker verify the database certificate with the RDS bundle shipped in the image', () => {
    for (const f of ['task-def-api.json', 'task-def-worker.json', 'task-def-migrate.json']) {
      expect(envOf(f).DATABASE_SSL_CA_FILE).toBe('/opt/dpdp/certs/rds-global-bundle.pem');
    }
    const dockerfile = readFileSync(join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(
      /--checksum=sha256:[0-9a-f]{64}[\s\\]+https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem \/opt\/dpdp\/certs\/rds-global-bundle\.pem/,
    );
    // ADD --chmod=0644 also strips the execute bit from the directories it
    // creates; without this the non-root process cannot reach the bundle.
    expect(dockerfile).toMatch(/chmod 0755 \/opt\/dpdp \/opt\/dpdp\/certs/);
  });

  it('the API is behind one proxy hop and keeps import evidence in S3', () => {
    const env = envOf('task-def-api.json');
    expect(env.TRUST_PROXY).toBe('1');
    expect(env.IMPORT_EVIDENCE_STORE).toBe('s3');
    expect(env.AWS_REGION).toBe('ap-south-1');
  });

  it('every task stops gracefully (30 s, matching compose stop_grace_period)', () => {
    for (const f of ['task-def-api.json', 'task-def-worker.json', 'task-def-frontend.json'])
      expect(task(f).stopTimeout).toBe(30);
  });

  it('the API and worker templates pass startup validation as production (secrets stand in for injected values)', () => {
    const fake = (n: string) =>
      n.endsWith('_URL')
        ? 'postgresql://role:pw@db.abc.ap-south-1.rds.amazonaws.com:5432/dpdp'
        : n.endsWith('_ENC_KEY')
          ? Buffer.alloc(32, 7).toString('base64')
          : 'x'.repeat(48);
    for (const [f, proc] of [
      ['task-def-api.json', 'api'],
      ['task-def-worker.json', 'worker'],
    ] as const) {
      const env: Record<string, string> = { ...envOf(f) } as Record<string, string>;
      for (const s of secretNames(f)) env[s] = fake(s);
      // Placeholders in the template are not real values; give them shapes.
      env.IMPORT_EVIDENCE_S3_BUCKET = 'dpdp-evidence-prod';
      env.IMPORT_EVIDENCE_RETENTION_DAYS = '2555';
      env.WEB_ORIGIN = 'https://app.example.com';
      env.DATABASE_SSL_CA_FILE = join(__dirname, '..', '..', 'package.json'); // any readable file...
      const { errors } = checkEnv(env, proc);
      // ...which is not a PEM: the one expected error proves the CA file IS checked.
      expect(errors).toEqual([expect.stringMatching(/does not contain a PEM certificate/)]);
    }
  });
});
