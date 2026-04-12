export default {
  '*': (_files) => [
    'pnpm run format',
    'pnpm run typecheck',
    'pnpm run oxlint',
    `git add ${_files.join(' ')}`,
  ],
};
