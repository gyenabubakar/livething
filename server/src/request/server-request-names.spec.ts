/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WIRE_LIMITS } from '@livething/core';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { stream } from '~/stream/capability.ts';
import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '~/server-definition.ts';
import { clientRequests } from './client-requests.ts';
import { serverRequests } from './server-requests.ts';

const SEPARATOR = /contains '::'/;

describe("names with '::' fail when the engine is built", () => {
  it('refuses a JSON or a binary server request at the top level', () => {
    const json = server({
      capabilities: [serverRequests({ 'confirm::delete': { out: t<null>() } })],
    });
    const bytes = server({
      capabilities: [
        binary({ serverRequests: { 'capture::screen': { out: t<null>() } } }),
        serverRequests(),
      ],
    });

    expect(() => compileServerDefinition(json.assemble({ handlers: [] }))).toThrow(SEPARATOR);
    expect(() => compileServerDefinition(bytes.assemble({ handlers: [] }))).toThrow(SEPARATOR);
  });

  it('refuses a JSON or a binary server request in a channel', () => {
    const base = server({ capabilities: [binary(), channels(), serverRequests()] });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {
      capabilities: [serverRequests({ 'approve::pin': { out: t<null>() } })],
    });
    const studios = base.channel(['studios', 'studio:{studioId}'], {
      capabilities: [binary({ serverRequests: { 'capture::board': { out: t<null>() } } })],
    });

    expect(() => compileServerDefinition(base.assemble({ handlers: [rooms] }))).toThrow(SEPARATOR);
    expect(() => compileServerDefinition(base.assemble({ handlers: [studios] }))).toThrow(
      SEPARATOR,
    );
  });

  it("refuses one in a plugin, but not the plugin's own __<id>:: prefix", () => {
    function pluginWith(name: string) {
      const polls = server({
        scope: 'plugin',
        capabilities: [serverRequests({ [name]: { out: t<null>() } })],
      });
      const Polls = plugin('acme:polls', { definition: polls.assemble({ handlers: [] }) });
      return server({ capabilities: [Polls()] }).assemble({ handlers: [] });
    }

    expect(() => compileServerDefinition(pluginWith('confirm::vote'))).toThrow(SEPARATOR);
    expect(() => compileServerDefinition(pluginWith('confirm-vote'))).not.toThrow();
  });

  it('refuses a plugin server request whose wire name is over the limit, JSON or binary', () => {
    const longName = 'c'.repeat(WIRE_LIMITS.event);
    const json = server({
      scope: 'plugin',
      capabilities: [serverRequests({ [longName]: { out: t<null>() } })],
    });
    const bytes = server({
      scope: 'plugin',
      capabilities: [
        binary({ serverRequests: { [longName]: { out: t<null>() } } }),
        serverRequests(),
        channels(),
      ],
    });
    const stage = bytes.channel('stage', {
      capabilities: [binary({ serverRequests: { [longName]: { out: t<null>() } } })],
    });
    function hostOf(id: string, definition: ServerDefinition) {
      return server({ capabilities: [plugin(id, { definition })()] }).assemble({ handlers: [] });
    }

    const tooLong = /characters; the wire protocol limit is/;

    expect(() =>
      compileServerDefinition(hostOf('acme:polls', json.assemble({ handlers: [] }))),
    ).toThrow(tooLong);
    expect(() =>
      compileServerDefinition(hostOf('acme:files', bytes.assemble({ handlers: [stage] }))),
    ).toThrow(tooLong);
  });

  it.each([
    [
      'an emits() event',
      () =>
        server({ capabilities: [emits({ 'user::renamed': t<null>() })] }).assemble({
          handlers: [],
        }),
    ],
    [
      'a request handler',
      () => {
        const base = server({ capabilities: [clientRequests()] });
        return base.assemble({ handlers: [base.request('get::profile', { run: () => null })] });
      },
    ],
    [
      'a stream',
      () => {
        const base = server({ capabilities: [stream()] });
        return base.assemble({ handlers: [base.stream('export::room', { async *run() {} })] });
      },
    ],
    [
      'a channel emits() event and request handler',
      () => {
        const base = server({ capabilities: [channels(), clientRequests()] });
        const rooms = base.channel(['rooms', 'room:{roomId}'], {
          capabilities: [emits({ 'room::typing': t<null>() })],
        });
        return base.assemble({
          handlers: [rooms, rooms.request('load::history', { run: () => null })],
        });
      },
    ],
  ])('refuses %s too', (_kind, build) => {
    expect(() => compileServerDefinition(build())).toThrow(SEPARATOR);
  });
});

describe("names that start or end with '__' fail when they are declared", () => {
  it.each(['__confirm-delete', 'confirm-delete__'])('refuses the server request %s', (name) => {
    expect(() => serverRequests({ [name]: { out: t<null>() } })).toThrow();
    expect(() => binary({ serverRequests: { [name]: { out: t<null>() } } })).toThrow();

    const base = server({ capabilities: [channels(), serverRequests()] });
    expect(() =>
      base.channel('lobby', { capabilities: [serverRequests({ [name]: { out: t<null>() } })] }),
    ).toThrow();
  });
});
