import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBase64Url } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

interface Seen {
  authorization: string | null;
  protocols: string | null;
}

let seen: Seen | undefined;

function buildEngine(): Engine {
  const definition = server({
    authenticate(request) {
      seen = {
        authorization: request.headers.get('authorization'),
        protocols: request.headers.get('sec-websocket-protocol'),
      };
      return {};
    },
  }).assemble({ handlers: [] });

  let captured: Engine | undefined;
  adapter({
    id: 'authenticate-token',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: { setAlarm() {}, deleteAlarm() {} } as never,
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

function handshake(protocols: string, headers: Record<string, string> = {}): Request {
  return new Request('https://huddle.test/huddle', {
    headers: { 'Sec-WebSocket-Protocol': protocols, ...headers },
  });
}

describe('the token subprotocol', () => {
  let engine: Engine;

  beforeEach(async () => {
    seen = undefined;
    engine = buildEngine();
    await engine.initialize();
  });

  it('reaches authenticate as a bearer Authorization header', async () => {
    await engine.authenticate(
      handshake(`livething-v1, livething-v1.token.${encodeBase64Url('session-8f2c')}`),
    );

    expect(seen).toEqual({ authorization: 'Bearer session-8f2c', protocols: 'livething-v1' });
  });

  it("keeps the app's own protocols and drops only the token entry", async () => {
    await engine.authenticate(
      handshake(`huddle.v2, huddle.v1, livething-v1.token.${encodeBase64Url('t')}`),
    );

    expect(seen?.protocols).toBe('huddle.v2, huddle.v1');
  });

  it('lets a real Authorization header win over the token', async () => {
    await engine.authenticate(
      handshake(`livething-v1, livething-v1.token.${encodeBase64Url('from-token')}`, {
        Authorization: 'Bearer from-header',
      }),
    );

    expect(seen).toEqual({ authorization: 'Bearer from-header', protocols: 'livething-v1' });
  });

  it('decodes a large token', async () => {
    const token = 'x'.repeat(11_625);
    await engine.authenticate(
      handshake(`livething-v1, livething-v1.token.${encodeBase64Url(token)}`),
    );

    expect(seen?.authorization).toBe(`Bearer ${token}`);
  });

  it('rejects a token entry that is not base64url with 400, without running authenticate', async () => {
    const decision = await engine.authenticate(handshake('livething-v1, livething-v1.token.a+b'));

    expect(decision).toEqual({ reject: true, code: 400, reason: 'Invalid token subprotocol' });
    expect(seen).toBeUndefined();
  });

  // `Headers` holds Latin-1 text with no line breaks or NUL, so such a token can't be a header.
  it.each(['€uro', '🙂', 'a\nb', 'a\rb', 'a\0b'])(
    'rejects a token %j that cannot be an Authorization header with 400',
    async (token) => {
      const decision = await engine.authenticate(
        handshake(`livething-v1, livething-v1.token.${encodeBase64Url(token)}`),
      );

      expect(decision).toEqual({ reject: true, code: 400, reason: 'Invalid token subprotocol' });
      expect(seen).toBeUndefined();
    },
  );

  it('keeps a Latin-1 token', async () => {
    await engine.authenticate(
      handshake(`livething-v1, livething-v1.token.${encodeBase64Url('café')}`),
    );

    expect(seen?.authorization).toBe('Bearer café');
  });

  it('leaves a request with no token entry unchanged', async () => {
    await engine.authenticate(handshake('huddle.v2'));

    expect(seen).toEqual({ authorization: null, protocols: 'huddle.v2' });
  });
});
