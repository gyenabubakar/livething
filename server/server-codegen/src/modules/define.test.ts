import { error } from '~/errors/errors.ts';
import { errors } from '~/errors/index.ts';
import { defineModule } from '~/modules/define.ts';
import { outgoing } from '~/outgoing/index.ts';
import { t } from '~/t.ts';

const ModuleLimited = error('rate-limited', (value: unknown) => value as { retryAfter: number });

const Analytics = defineModule({
  id: 'acme:analytics',
  key: Symbol('acme:analytics'),
  outgoing: [outgoing('flushed', t<{ count: number }>())] as const,
  errors: errors(ModuleLimited),
  requires: {
    storage: true,
  },
  setup() {
    return () => ({
      flush() {
        return { count: 1 };
      },
    });
  },
});

const moduleInstance = Analytics({});

const _tag: 'module' = moduleInstance.__wskit;
const _id: string = Analytics.id;
const _storageRequired: boolean | undefined = moduleInstance.__requires.storage;
const _api = Analytics.use;
void [_tag, _id, _storageRequired, _api];
