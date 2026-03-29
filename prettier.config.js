// @ts-check

/** @type {import('prettier').Config} */
const config = {
  arrowParens: 'always',
  bracketSpacing: true,
  jsxSingleQuote: false,
  quoteProps: 'as-needed',
  singleQuote: true,
  semi: true,
  printWidth: 100,
  useTabs: false,
  tabWidth: 2,
  trailingComma: 'all',
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: [
    '<THIRD_PARTY_MODULES>',
    '<TYPES><THIRD_PARTY_MODULES>',
    '<TYPES>',
    '^[.]',
    '<TYPES>^[.]',
    '',
  ],
};

export default config;
