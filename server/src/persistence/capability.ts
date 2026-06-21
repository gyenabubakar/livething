import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { persistence as persistenceFactory } from '~/persistence/persistence.ts';

/**
 * Turn on durable storage. This is the prerequisite for features that must
 * survive a restart — durable streams and persistent channel membership — so
 * those fail the build if it is not listed.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { persistence } from '@wskit/server/persistence';
 *
 * const base = define({ env: t<Env>(), capabilities: [persistence()] });
 * ```
 */
export const persistence = defineHostCapability(CAPABILITY_KIND.persistence, () =>
  persistenceFactory(),
);
