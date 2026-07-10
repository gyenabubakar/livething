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
  overrides: [
    {
      // Only the fenced code blocks inside these pages get formatted. The docs
      // write their snippets without semicolons, so the embedded TypeScript
      // follows the docs' house style rather than the repo's. The narrower
      // width keeps a snippet inside the rendered code column, where a line
      // that fits an editor would wrap and be hard to read.
      files: 'website/content/**/*.md',
      options: { semi: false, printWidth: 80 },
    },
  ],
};

export default config;
