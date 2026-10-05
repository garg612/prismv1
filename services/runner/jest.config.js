/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  transformIgnorePatterns: [
    "node_modules/(?!chalk|e2b|@e2b/code-interpreter)"
  ]
};
