import { describe, expect, it } from 'vitest';
import {
  createDefaultWskitTemplate,
  generateWskitDeclarationText,
  parseWskitModule,
  toGeneratedFilePath,
} from './generator.ts';

describe('wskit codegen parser', () => {
  it('parses a default-exported define(...) file and generates registry output', () => {
    const code = `
      import { received, server, t } from '@wskit/server-codegen';
      import { ack as _ack } from '@wskit/server-codegen/ack';
      import { heartbeat as _heartbeat } from '@wskit/server-codegen/heartbeat';
      import { incoming as _incoming } from '@wskit/server-codegen/incoming';
      import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';

      const { define, ack, incoming, outgoing, heartbeat } = server('chat', {
        _ack,
        _incoming,
        _outgoing,
        _heartbeat,
      });

      export default define(
        heartbeat({ timeout: 30000 }),
        ack(),
        outgoing('message', t<{ text: string }>()),
        outgoing('alert', t<{ level: string }>()),
        incoming(received('send-message', (value: unknown) => value as { text: string }), async (ctx, payload) => {
          ctx.ack();
          ctx.send('message', { text: payload.text });
        }),
      );
    `;

    const parsed = parseWskitModule(code, '/repo/src/chat.wskit.ts');
    expect(parsed.serverName).toBe('chat');
    expect(parsed.scope.outgoing).toEqual({
      message: '{ text: string }',
      alert: '{ level: string }',
    });

    const output = generateWskitDeclarationText(parsed);
    expect(output).toContain('declare global');
    expect(output).toContain('interface WskitServerRegistry');
    expect(output).toContain('"chat"');
    expect(output).toContain('"message": { text: string };');
    expect(output).toContain('"alert": { level: string };');
    expect(output).toContain('ack(): void;');
    expect(output).toContain('readonly id: string;');
    expect(output).toContain('readonly meta: Record<string, unknown>;');
    expect(output).toContain('readonly bufferedAmount: number;');
    expect(output).toContain('readonly latency: number | null;');
    expect(output).toContain("readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';");
    expect(output).toContain('readonly tags: readonly string[];');
    expect(output).toContain('tag(label: string): void;');
    expect(output).toContain('send(event: "message", payload: { text: string }): void;');
    expect(output).toContain('broadcast(event: "alert", payload: { level: string }): void;');
  });

  it('generates typed schedule and cancelScheduled methods from declared scheduled tasks', () => {
    const code = `
      import { received, server, t } from '@wskit/server-codegen';
      import { incoming as _incoming } from '@wskit/server-codegen/incoming';
      import { scheduled as _scheduled } from '@wskit/server-codegen/scheduled';

      const { define, incoming, scheduled } = server('chat', {
        _incoming,
        _scheduled,
      });

      export default define(
        scheduled('cleanup-sessions', async () => {}),
        scheduled(
          'expire-hold',
          async (_ctx, data) => {
            console.log(data.orderId);
          },
          { data: t<{ orderId: string }>() },
        ),
        incoming(received('place-order', (value: unknown) => value as { orderId: string }), async (ctx, payload) => {
          ctx.schedule('expire-hold', {
            time: Date.now() + 1000,
            data: { orderId: payload.orderId },
          });
        }),
      );
    `;

    const parsed = parseWskitModule(code, '/repo/src/chat.wskit.ts');
    expect(parsed.scope.scheduled).toEqual({
      'cleanup-sessions': 'unknown',
      'expire-hold': '{ orderId: string }',
    });

    const output = generateWskitDeclarationText(parsed);
    expect(output).toContain('readonly id: string;');
    expect(output).toContain('readonly meta: Record<string, unknown>;');
    expect(output).toContain('readonly bufferedAmount: number;');
    expect(output).toContain('readonly latency: number | null;');
    expect(output).toContain("readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';");
    expect(output).toContain('readonly tags: readonly string[];');
    expect(output).toContain('tag(label: string): void;');
    expect(output).toContain(
      'schedule(taskId: "cleanup-sessions", options: { time: number; data?: unknown }): void;',
    );
    expect(output).toContain(
      'schedule(taskId: "expire-hold", options: { time: number; data?: { orderId: string } }): void;',
    );
    expect(output).toContain(
      'cancelScheduled(taskId: "expire-hold", filter?: { orderId: string } extends Record<string, unknown> ? Partial<{ orderId: string }> : Record<string, unknown>): void;',
    );
  });

  it('creates .wskit output paths relative to the workspace root', () => {
    expect(
      toGeneratedFilePath('/repo/src/chat.wskit.ts', {
        rootDir: '/repo',
        outDir: '/repo/.wskit',
      }),
    ).toBe('/repo/.wskit/src/chat.wskit.d.ts');
  });

  it('creates a starter template for empty wskit files', () => {
    const template = createDefaultWskitTemplate('/repo/src/my/name/is/ha.wskit.ts');

    expect(template).toContain("server('ha'");
    expect(template).toContain("outgoing('message'");
    expect(template).toContain("received('send-message'");
  });

  it('captures namespace and channel ctx maps', () => {
    const code = `
      import {
        received,
        scope,
        server,
        t
      } from '@wskit/server-codegen';
      import { channel as _channel } from '@wskit/server-codegen/channel';
      import { incoming as _incoming } from '@wskit/server-codegen/incoming';
      import { namespace as _namespace } from '@wskit/server-codegen/namespace';
      import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';
      import { replay as _replay } from '@wskit/server-codegen/replay';

      const { define, incoming, outgoing, namespace, channel, replay } = server('chat', {
        _incoming,
        _outgoing,
        _namespace,
        _channel,
        _replay,
      });

      export default define(
        outgoing('message', t<{ text: string }>()),
        namespace(
          'notifications',
          outgoing('alert', t<{ id: string }>()),
          incoming(received('dismiss'), async (ctx) => {
            ctx.namespace.send('alert', { id: 'a1' });
          }),
        ),
        channel(
          scope('general', /^general$/),
          replay(),
          outgoing('typing', t<{ userId: string }>()),
          incoming(received('start-typing'), async (ctx) => {
            ctx.channel.sendReplay('typing', { userId: 'u1' }, { seq: 1, messageId: 'm1' });
          }),
        ),
        incoming(received('ping'), async (ctx) => {
          ctx.send('message', { text: 'pong' });
        }),
      );
    `;

    const parsed = parseWskitModule(code, '/repo/src/chat.wskit.ts');
    expect(parsed.scope.namespaces.notifications?.outgoing).toEqual({
      alert: '{ id: string }',
    });
    expect(parsed.scope.channels.general?.outgoing).toEqual({
      typing: '{ userId: string }',
    });

    const output = generateWskitDeclarationText(parsed);
    expect(output).toContain('"notifications"');
    expect(output).toContain('"general"');
    expect(output).toContain('"typing": { userId: string };');
    expect(output).toContain('readonly id: string;');
    expect(output).toContain('readonly meta: Record<string, unknown>;');
    expect(output).toContain('readonly bufferedAmount: number;');
    expect(output).toContain('readonly latency: number | null;');
    expect(output).toContain("readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';");
    expect(output).toContain('readonly tags: readonly string[];');
    expect(output).toContain('tag(label: string): void;');
    expect(output).toContain('namespace: {');
    expect(output).toContain('name: "notifications";');
    expect(output).toContain('send(event: "alert", payload: { id: string }): void;');
    expect(output).toContain('channel: {');
    expect(output).toContain('name: string;');
    expect(output).toContain(
      'sendReplay(event: "typing", payload: { userId: string }, meta: { seq: number; messageId: string }): void;',
    );
  });

  it('ignores generate() inside scopes without affecting scope collection', () => {
    const code = `
      import { received, server, t } from '@wskit/server-codegen';
      import { channel as _channel, scope } from '@wskit/server-codegen/channel';
      import { incoming as _incoming } from '@wskit/server-codegen/incoming';
      import { namespace as _namespace } from '@wskit/server-codegen/namespace';
      import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';
      import { stream as _stream, chunks, generate, nudge, start } from '@wskit/server-codegen/stream';

      const { define, incoming, outgoing, namespace, channel, stream } = server('chat', {
        _incoming,
        _outgoing,
        _namespace,
        _channel,
        _stream,
      });

      const aiStream = stream(
        start('ask-ai', (value: unknown) => value as { prompt: string }),
        chunks(t<{ text: string; done: boolean }>()),
        nudge('cancel'),
      );

      export default define(
        outgoing('message', t<{ text: string }>()),
        generate(aiStream, async function* (ctx, payload) {
          yield { text: payload.prompt, done: true };
        }),
        namespace(
          'notifications',
          outgoing('notice', t<{ id: string; text: string }>()),
          incoming(received('dismiss'), async (ctx) => {
            ctx.namespace.send('notice', { id: 'a1', text: 'dismissed' });
          }),
          generate(
            stream(
              start('notice-stream', (value: unknown) => value as { id: string }),
              chunks(t<{ id: string; text: string }>()),
            ),
            async function* (ctx, payload) {
              yield { id: payload.id, text: 'opened' };
            },
          ),
        ),
        channel(
          scope('rooms', /^room-/),
          outgoing('typing', t<{ userId: string }>()),
          incoming(received('start-typing'), async (ctx) => {
            ctx.channel.send('typing', { userId: 'u1' });
          }),
          generate(
            stream(
              start('room-ai', (value: unknown) => value as { room: string }),
              chunks(t<{ text: string }>()),
            ),
            async function* (ctx, payload) {
              yield { text: payload.room };
            },
          ),
        ),
      );
    `;

    const parsed = parseWskitModule(code, '/repo/src/chat.wskit.ts');

    expect(parsed.scope.outgoing).toEqual({ message: '{ text: string }' });
    expect(parsed.scope.namespaces.notifications?.outgoing).toEqual({
      notice: '{ id: string; text: string }',
    });
    expect(parsed.scope.namespaces.notifications?.incomingEvents).toEqual(['dismiss']);
    expect(parsed.scope.channels.rooms?.outgoing).toEqual({
      typing: '{ userId: string }',
    });
    expect(parsed.scope.channels.rooms?.incomingEvents).toEqual(['start-typing']);

    const output = generateWskitDeclarationText(parsed);
    expect(output).toContain('"notifications"');
    expect(output).toContain('"rooms"');
    expect(output).toContain('incomingContexts: {');
    expect(output).toContain(
      '"dismiss": WskitServerRegistry["chat"]["namespaces"]["notifications"]["ctx"];',
    );
    expect(output).toContain(
      '"start-typing": WskitServerRegistry["chat"]["channels"]["rooms"]["ctx"];',
    );
  });

  it('generates incoming, request, and post-intercept ctx maps', () => {
    const code = `
      import {
        received,
        scope,
        server,
        t
      } from '@wskit/server-codegen';
      import { ack as _ack } from '@wskit/server-codegen/ack';
      import { channel as _channel } from '@wskit/server-codegen/channel';
      import { incoming as _incoming } from '@wskit/server-codegen/incoming';
      import { intercept as _intercept } from '@wskit/server-codegen/intercept';
      import { namespace as _namespace } from '@wskit/server-codegen/namespace';
      import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';
      import { replay as _replay } from '@wskit/server-codegen/replay';
      import { request as _request } from '@wskit/server-codegen/request';

      const { define, incoming, outgoing, request, intercept, namespace, channel, replay } = server('chat', {
        _ack,
        _incoming,
        _intercept,
        _namespace,
        _channel,
        _outgoing,
        _replay,
        _request,
      });

      export default define(
        outgoing('message', t<{ text: string }>()),
        intercept('send-message', async (ctx, payload: { text: string }) => {
          ctx.ack();
          ctx.send('message', { text: payload.text });
          return payload;
        }),
        request(
          'get-status',
          async (ctx, payload: { room: string }) => {
            ctx.ack();
            ctx.send('message', { text: payload.room });
            return { ok: true };
          },
          { validator: (value: unknown) => value as { room: string } },
        ),
        namespace(
          'notifications',
          outgoing('alert', t<{ id: string }>()),
          intercept('dismiss', async (ctx, payload: { id: string }) => {
            ctx.namespace.send('alert', { id: payload.id });
            return payload;
          }),
          incoming(received('dismiss', (value: unknown) => value as { id: string }), async (ctx) => {
            ctx.namespace.broadcast('alert', { id: 'a1' });
          }),
        ),
        channel(
          scope('rooms', /^room-/),
          replay(),
          outgoing('typing', t<{ userId: string }>()),
          intercept('start-typing', async (ctx, payload: { userId: string }) => {
            ctx.channel.sendReplay('typing', { userId: payload.userId }, { seq: 1, messageId: 'm1' });
            return payload;
          }),
          incoming(received('start-typing', (value: unknown) => value as { userId: string }), async (ctx) => {
            ctx.channel.send('typing', { userId: 'u1' });
          }),
        ),
      );
    `;

    const parsed = parseWskitModule(code, '/repo/src/chat.wskit.ts');
    const output = generateWskitDeclarationText(parsed);

    expect(output).toContain('incomingContexts: {');
    expect(output).toContain(
      '"dismiss": WskitServerRegistry["chat"]["namespaces"]["notifications"]["ctx"];',
    );
    expect(output).toContain(
      '"start-typing": WskitServerRegistry["chat"]["channels"]["rooms"]["ctx"];',
    );
    expect(output).toContain('namespace: {');
    expect(output).toContain('channel: {');
    expect(output).toContain('requestContexts: {');
    expect(output).toContain('"get-status": WskitServerRegistry["chat"]["ctx"];');
    expect(output).toContain('postInterceptContexts: {');
    expect(output).toContain('"send-message": WskitServerRegistry["chat"]["ctx"];');
    expect(output).toContain(
      'sendReplay(event: "typing", payload: { userId: string }, meta: { seq: number; messageId: string }): void;',
    );
  });
});
