// Type-only checks for the admin type. tsc checks these; vitest never runs them.
import { server } from '~/_define/server.ts';
import { expectTypeOf } from 'vitest';
import type { AdminOf } from '~/server-definition.ts';

// No channels() or scheduled(): at runtime the admin object still has the built-in
// `channels` and `schedule`, which win over the app's own, so the type must not offer the
// app's versions.
const huddle = server({}).assemble({
  handlers: [],
  api: () => ({
    channels: (): number => 1,
    schedule: (): string => 'tomorrow',
    sendDigest: (): boolean => true,
  }),
});
type HuddleAdmin = AdminOf<typeof huddle>;

expectTypeOf<HuddleAdmin['sendDigest']>().toEqualTypeOf<() => boolean>();
expectTypeOf<HuddleAdmin>().not.toHaveProperty('channels');
expectTypeOf<HuddleAdmin>().not.toHaveProperty('schedule');
