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
    expect(output).toContain('send(event: "message", payload: { text: string }): void;');
    expect(output).toContain('broadcast(event: "alert", payload: { level: string }): void;');
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
    expect(output).toContain('namespace: {');
    expect(output).toContain('name: "notifications";');
    expect(output).toContain('send(event: "alert", payload: { id: string }): void;');
    expect(output).toContain('channel: {');
    expect(output).toContain('name: string;');
    expect(output).toContain(
      'sendReplay(event: "typing", payload: { userId: string }, meta: { seq: number; messageId: string }): void;',
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
