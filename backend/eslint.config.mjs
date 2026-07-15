import base from '../eslint.config.base.mjs';

export default [
  ...base,
  {
    rules: {
      // NestJS DI relies heavily on decorators and empty constructors.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
