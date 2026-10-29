import type { Config } from 'jest';

const config: Config = {
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/env.ts'],
  testEnvironment: 'node',
};

export default config;
