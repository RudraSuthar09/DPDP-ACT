/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^@dpdp/shared$': '<rootDir>/../../shared/src/index.ts',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
