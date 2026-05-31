export default {
  '*': () => ['pnpm run format', 'pnpm run typecheck', 'pnpm run lint'],
};
