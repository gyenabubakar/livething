/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { ConnectionRef } from '~/context.ts';

describe('capability-owned, TS-gated ctx extensions', () => {
  it('omits every capability-owned field on a bare server', () => {
    const base = server({});
    base.on('x', {
      run(ctx) {
        // @ts-expect-error ctx.schedule needs the scheduled() capability
        ctx.schedule;
        // @ts-expect-error ctx.cancelScheduled needs the scheduled() capability
        ctx.cancelScheduled;
        // @ts-expect-error ctx.tags needs the tags() capability
        ctx.tags;
        // @ts-expect-error ctx.latency needs the keepalive() capability
        ctx.latency;
        // @ts-expect-error ctx.quality needs the keepalive() capability
        ctx.quality;
        // @ts-expect-error ctx.channels needs the channels() capability
        ctx.channels;
        // @ts-expect-error ctx.plugin needs a plugin listed
        ctx.plugin;
        // @ts-expect-error ctx.request needs the serverRequests() capability
        ctx.request;
        // @ts-expect-error ctx.broadcastRequest needs the serverRequests() capability
        ctx.broadcastRequest;
        expectTypeOf(ctx.connection.id).toEqualTypeOf<string>();
      },
    });
  });

  it('adds ctx.request and the connection-handle request arm only with serverRequests()', () => {
    const base = server({
      capabilities: [
        serverRequests({
          'ask-permission': {
            out: t<{ action: string }>(),
            in: v.object({ allowed: v.boolean() }),
          },
          volunteer: { out: t<{ turn: number }>(), in: v.object({ ready: v.boolean() }) },
        }),
      ],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.request).toBeFunction();
        const answer = ctx.request('ask-permission', { action: 'delete' });
        expectTypeOf(answer).resolves.toEqualTypeOf<{ allowed: boolean }>();
        ctx.request('volunteer', { turn: 1 });
        // @ts-expect-error wrong payload shape for 'ask-permission'
        ctx.request('ask-permission', { action: 1 });

        const handle = ctx.connections.get(ctx.connection);
        expectTypeOf(handle.request).toBeFunction();
        expectTypeOf(handle.request('ask-permission', { action: 'x' })).resolves.toEqualTypeOf<{
          allowed: boolean;
        }>();
      },
    });
  });

  it('adds broadcastRequest on every fan-out surface for every declared request', () => {
    const base = server({
      capabilities: [
        serverRequests({
          'ask-permission': {
            out: t<{ action: string }>(),
            in: v.object({ allowed: v.boolean() }),
          },
          volunteer: { out: t<{ turn: number }>(), in: v.object({ ready: v.boolean() }) },
        }),
        channels(),
        tags((ephemeral) => [ephemeral('role', t<string>())]),
      ],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.broadcastRequest).toBeFunction();
        const result = ctx.broadcastRequest('volunteer', { turn: 5 });
        expectTypeOf(result).resolves.toMatchTypeOf<{
          response: { ready: boolean };
          from: ConnectionRef;
        }>();
        ctx.broadcastRequest('ask-permission', { action: 'x' });
        // @ts-expect-error wrong payload shape for 'volunteer'
        ctx.broadcastRequest('volunteer', { turn: 'soon' });

        const lobby = ctx.channels.get('lobby');
        expectTypeOf(lobby.broadcastRequest).toBeFunction();
        expectTypeOf(lobby.broadcastRequest('volunteer', { turn: 1 })).resolves.toMatchTypeOf<{
          response: { ready: boolean };
        }>();
        // @ts-expect-error a channel handle has no targeted request verb
        lobby.request;

        const group = ctx.tags.ephemeral('role');
        expectTypeOf(group.broadcastRequest).toBeFunction();
        expectTypeOf(group.ref('admin').broadcastRequest).toBeFunction();
        // @ts-expect-error a tag group is broadcast-only, no targeted request
        group.request;
      },
    });
  });

  it('omits broadcastRequest on channel/tag handles without serverRequests()', () => {
    const base = server({
      capabilities: [channels(), tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    base.on('x', {
      run(ctx) {
        // @ts-expect-error broadcastRequest needs the serverRequests() capability
        ctx.channels.get('lobby').broadcastRequest;
        // @ts-expect-error broadcastRequest needs the serverRequests() capability
        ctx.tags.ephemeral('role').broadcastRequest;
      },
    });
  });

  it('always exposes ctx.connection(ref).send, typed to the emits catalog', () => {
    const base = server({
      capabilities: [emits({ ping: t<{ n: number }>() })],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.connections.get).toBeFunction();
        const handle = ctx.connections.get(ctx.connection);
        expectTypeOf(handle.send).toBeFunction();
        handle.send('ping', { n: 1 });
        // @ts-expect-error 'nope' is not a declared outgoing event
        handle.send('nope', { n: 1 });
        // @ts-expect-error wrong payload shape for 'ping'
        handle.send('ping', { n: 'x' });
      },
    });
  });

  it('exposes ctx.connections.get on a bare server with no capabilities', () => {
    const base = server({});
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.connections.get).toBeFunction();
        expectTypeOf(ctx.connection).toEqualTypeOf<ConnectionRef>();
      },
    });
  });

  it('adds ctx.schedule / ctx.cancelScheduled only with scheduled()', () => {
    const base = server({
      capabilities: [scheduled({ cleanup: null })],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.schedule).toBeFunction();
        expectTypeOf(ctx.cancelScheduled).toBeFunction();
      },
    });
  });

  it('adds ctx.latency / ctx.quality only with keepalive()', () => {
    const base = server({
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 })],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.latency).toEqualTypeOf<number | null>();
        expectTypeOf(ctx.quality).toEqualTypeOf<
          'excellent' | 'good' | 'degraded' | 'poor' | null
        >();
      },
    });
  });

  it('adds ctx.tags only with tags()', () => {
    const base = server({
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.tags).not.toBeUndefined();
      },
    });
  });

  it('uses broadcast on every handle that can reach multiple connections', () => {
    const base = server({
      capabilities: [
        emits({ notice: t<{ text: string }>() }),
        tags((ephemeral) => [ephemeral('role', t<string>())]),
      ],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.user.broadcast('notice', { text: 'hello' })).toEqualTypeOf<number>();
        ctx.tags.ephemeral('role').broadcast('notice', { text: 'hello' });
        ctx.tags.ephemeral('role').ref('admin').broadcast('notice', { text: 'hello' });

        // @ts-expect-error UserHandle fans out, so it has no send method
        ctx.user.send('notice', { text: 'hello' });
        // @ts-expect-error TagGroupHandle fans out, so it has no send method
        ctx.tags.ephemeral('role').send('notice', { text: 'hello' });
        // @ts-expect-error TagRefHandle fans out, so it has no send method
        ctx.tags.ephemeral('role').ref('admin').send('notice', { text: 'hello' });
      },
    });
  });

  it('adds ctx.channels only with channels()', () => {
    const base = server({ capabilities: [channels()] });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.channels.get).toBeFunction();
      },
    });
  });
});
