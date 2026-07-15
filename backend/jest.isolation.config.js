/**
 * Cross-tenant isolation suite (NFR-SEC-05, rule R5). This config runs the
 * tests that *attempt* unauthorised cross-tenant reads and must get ZERO rows.
 * It runs on every PR in CI. The suite itself is added in the next step once the
 * first RLS-protected tables exist — this config wires it up now so the CI job
 * is real from day one.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'test/isolation',
  testRegex: '.*\\.isolation-spec\\.ts$',
  moduleNameMapper: {
    '^@dpdp/shared$': '<rootDir>/../../../shared/src/index.ts',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
