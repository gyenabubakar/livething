// Type-only checks: every built-in primitive carries its literal tag, both on the
// descriptor it returns and on the factory's static `tag`. `client()` reads these
// literals to reject a missing dependency at compile time, and a plugin's
// `dependencies` list reads the static ones. tsc checks these; vitest never runs them.
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { gaps } from '~/primitives/gaps.ts';
import { inbox, readReceipts } from '~/primitives/inbox/index.ts';
import { intercept } from '~/primitives/intercept.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { expectTypeOf } from 'vitest';
import type { connect } from '~/connect.ts';

expectTypeOf<ReturnType<typeof connect>['_tag']>().toEqualTypeOf<'connect'>();
expectTypeOf<ReturnType<typeof buffering>['_tag']>().toEqualTypeOf<'buffering'>();
expectTypeOf<ReturnType<typeof channels>['_tag']>().toEqualTypeOf<'channels'>();
expectTypeOf<ReturnType<typeof clientRequests>['_tag']>().toEqualTypeOf<'clientRequests'>();
expectTypeOf<ReturnType<typeof dedup>['_tag']>().toEqualTypeOf<'dedup'>();
expectTypeOf<ReturnType<typeof gaps>['_tag']>().toEqualTypeOf<'gaps'>();
expectTypeOf<ReturnType<typeof inbox>['_tag']>().toEqualTypeOf<'inbox'>();
expectTypeOf<ReturnType<typeof readReceipts>['_tag']>().toEqualTypeOf<'read-receipts'>();
expectTypeOf<ReturnType<typeof intercept>['_tag']>().toEqualTypeOf<'intercept'>();
expectTypeOf<ReturnType<typeof keepalive>['_tag']>().toEqualTypeOf<'keepalive'>();
expectTypeOf<ReturnType<typeof platform>['_tag']>().toEqualTypeOf<'platform'>();
expectTypeOf<ReturnType<typeof reconnection>['_tag']>().toEqualTypeOf<'reconnection'>();
expectTypeOf<ReturnType<typeof replay>['_tag']>().toEqualTypeOf<'replay'>();
expectTypeOf<ReturnType<typeof serverRequests>['_tag']>().toEqualTypeOf<'serverRequests'>();
expectTypeOf<ReturnType<typeof stream>['_tag']>().toEqualTypeOf<'stream'>();

expectTypeOf(buffering.tag).toEqualTypeOf<'buffering'>();
expectTypeOf(channels.tag).toEqualTypeOf<'channels'>();
expectTypeOf(clientRequests.tag).toEqualTypeOf<'clientRequests'>();
expectTypeOf(dedup.tag).toEqualTypeOf<'dedup'>();
expectTypeOf(gaps.tag).toEqualTypeOf<'gaps'>();
expectTypeOf(inbox.tag).toEqualTypeOf<'inbox'>();
expectTypeOf(readReceipts.tag).toEqualTypeOf<'read-receipts'>();
expectTypeOf(intercept.tag).toEqualTypeOf<'intercept'>();
expectTypeOf(keepalive.tag).toEqualTypeOf<'keepalive'>();
expectTypeOf(platform.tag).toEqualTypeOf<'platform'>();
expectTypeOf(reconnection.tag).toEqualTypeOf<'reconnection'>();
expectTypeOf(replay.tag).toEqualTypeOf<'replay'>();
expectTypeOf(serverRequests.tag).toEqualTypeOf<'serverRequests'>();
expectTypeOf(stream.tag).toEqualTypeOf<'stream'>();
