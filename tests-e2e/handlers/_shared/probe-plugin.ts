import { emits, server, t } from '@livething/server';
import { plugin } from '@livething/server/plugins';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';

// A pure-LiveThing plugin that sends through every per-connection surface a
// plugin ctx offers, and reports its own failures back to the client. Every
// frame it sends must travel under its `__e2e:probe::` namespace, and its
// `onError` / `onValidationError` must run only for its own events.
const h = server({
  scope: 'plugin',
  capabilities: [
    tags((ephemeral) => [ephemeral('room', t<string>())]),
    emits({
      'user-online': t<{ via: string }>(),
      'error-seen': t<{ event: string | null }>(),
      'validation-seen': t<{ event: string }>(),
    }),
  ],
});

const viaConnections = h.on('via-connections', {
  input: v.object({}),
  run(ctx) {
    ctx.connections.get(ctx.connection).send('user-online', { via: 'connections' });
  },
});

const viaUsers = h.on('via-users', {
  input: v.object({}),
  run(ctx) {
    ctx.users.get(ctx.user.id).broadcast('user-online', { via: 'users' });
    ctx.user.broadcast('user-online', { via: 'user' });
  },
});

const viaTags = h.on('via-tags', {
  input: v.object({}),
  run(ctx) {
    const room = ctx.tags.ephemeral('room');
    room.add('lobby');
    room.broadcast('user-online', { via: 'tag-group' });
    room.ref('lobby').broadcast('user-online', { via: 'tag-ref' });
  },
});

const fail = h.on('fail', {
  input: v.object({}),
  run() {
    throw new Error('e2e: probe handler failed');
  },
});

const strict = h.on('strict', {
  input: v.object({ n: v.number() }),
  run() {},
});

h.onError((ctx, _error, event) => {
  ctx.send('error-seen', { event: event ?? null });
});

h.onValidationError((ctx, event) => {
  ctx.send('validation-seen', { event });
});

export const Probe = plugin('e2e:probe', {
  definition: h.assemble({ handlers: [viaConnections, viaUsers, viaTags, fail, strict] }),
});
