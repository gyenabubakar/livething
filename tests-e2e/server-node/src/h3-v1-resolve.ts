import { registerHooks } from 'node:module';

// In this monorepo the name `h3` means H3 v2. The adapter's H3 v1 entry imports
// `h3`, so point that one import at the H3 v1 copy, the way it resolves in a
// real H3 v1 app.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'h3' && context.parentURL?.endsWith('/h3-v1.js')) {
      return nextResolve('h3-v1', { ...context, parentURL: import.meta.url });
    }

    return nextResolve(specifier, context);
  },
});
