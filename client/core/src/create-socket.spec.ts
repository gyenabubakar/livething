/* oxlint-disable @typescript-eslint/no-explicit-any -- testing createSocket with plugin wiring */
import { createSocket } from '@/create-socket.ts';
import { Ack } from '@/plugins/ack.ts';
import { Plugin } from '@/plugins/base.ts';
import { Channels } from '@/plugins/channels.ts';
import { Dedup } from '@/plugins/dedup.ts';
import { Replay } from '@/plugins/replay.ts';
import { RequestResponse } from '@/plugins/request-response.ts';
import { Stream } from '@/plugins/stream.ts';
import { describe, expect, it, vi } from 'vitest';
import type { StaticApi } from '@/types.ts';

describe('createSocket', () => {
  it('returns a socket with base methods', () => {
    const socket = createSocket('wss://example.com');

    expect(socket).toHaveProperty('connect');
    expect(socket).toHaveProperty('disconnect');
    expect(socket).toHaveProperty('getState');
    expect(socket).toHaveProperty('on');
    expect(socket).toHaveProperty('send');
    expect(socket).toHaveProperty('ws');
    expect(socket).toHaveProperty('protocol');
  });

  it('stores url and options on the socket', () => {
    const socket = createSocket('wss://example.com', { debug: true }) as any;

    expect(socket._url).toBe('wss://example.com');
    expect(socket._options.debug).toBe(true);
  });

  it('accepts a function URL', () => {
    function urlFn() {
      return 'wss://example.com';
    }
    const socket = createSocket(urlFn) as any;

    expect(socket._url).toBe(urlFn);
  });

  describe('plugin wiring', () => {
    it('sets helpers on each plugin', () => {
      const ack = new Ack();
      const dedup = new Dedup();

      createSocket('wss://example.com', { plugins: [ack, dedup] as any });

      expect(ack.helpers).toBeDefined();
      expect(ack.helpers.rawSend).toBeTypeOf('function');
      expect(ack.helpers.generateId).toBeTypeOf('function');
      expect(ack.helpers.getState).toBeTypeOf('function');

      expect(dedup.helpers).toBeDefined();
    });

    it('calls install on plugins that have it', () => {
      const ack = new Ack();
      const installSpy = vi.spyOn(ack, 'install');

      createSocket('wss://example.com', { plugins: [ack] as any });

      expect(installSpy).toHaveBeenCalledOnce();
    });

    it('does not crash on plugins without install', () => {
      const dedup = new Dedup();
      const replay = new Replay();

      expect(() => {
        createSocket('wss://example.com', { plugins: [dedup, replay] as any });
      }).not.toThrow();
    });

    it('Ack plugin attaches send.withAck', () => {
      const socket = createSocket('wss://example.com', {
        plugins: [new Ack()] as any,
      });

      expect((socket.send as any).withAck).toBeTypeOf('function');
    });

    it('RequestResponse plugin attaches request', () => {
      const socket = createSocket('wss://example.com', {
        plugins: [new RequestResponse()] as any,
      }) as any;

      expect(socket.request).toBeTypeOf('function');
    });

    it('Channels plugin attaches channel', () => {
      const socket = createSocket('wss://example.com', {
        plugins: [new Channels()] as any,
      }) as any;

      expect(socket.channel).toBeTypeOf('function');
    });

    it('Stream plugin attaches onStream', () => {
      const socket = createSocket('wss://example.com', {
        plugins: [new Stream()] as any,
      }) as any;

      expect(socket.onStream).toBeTypeOf('function');
    });

    it('multiple plugins all install their methods', () => {
      const socket = createSocket('wss://example.com', {
        plugins: [new Ack(), new RequestResponse(), new Channels(), new Stream()] as any,
      }) as any;

      expect((socket.send as any).withAck).toBeTypeOf('function');
      expect(socket.request).toBeTypeOf('function');
      expect(socket.channel).toBeTypeOf('function');
      expect(socket.onStream).toBeTypeOf('function');
    });
  });

  describe('helpers', () => {
    it('generateId produces unique prefixed IDs', () => {
      const ack = new Ack();
      const rr = new RequestResponse();

      createSocket('wss://example.com', { plugins: [ack, rr] as any });

      const id1 = ack.helpers.generateId('ack');
      const id2 = rr.helpers.generateId('req');
      const id3 = ack.helpers.generateId('ack');

      expect(id1).toBe('ack-1');
      expect(id2).toBe('req-2');
      expect(id3).toBe('ack-3');
    });

    it('generateId without prefix returns plain number', () => {
      const ack = new Ack();
      createSocket('wss://example.com', { plugins: [ack] as any });

      expect(ack.helpers.generateId()).toBe('1');
    });

    it('all plugins share the same counter', () => {
      const ack = new Ack();
      const rr = new RequestResponse();

      createSocket('wss://example.com', { plugins: [ack, rr] as any });

      ack.helpers.generateId('a');
      rr.helpers.generateId('b');
      const id = ack.helpers.generateId('a');

      expect(id).toBe('a-3');
    });
  });

  describe('custom plugin', () => {
    it('custom plugin can install its own method', () => {
      class MyPlugin extends Plugin<StaticApi<{ greet(): string }>> {
        id = 'my-plugin';

        override install(socket: Record<string, unknown>) {
          socket.greet = () => 'hello';
        }
      }

      const socket = createSocket('wss://example.com', {
        plugins: [new MyPlugin()] as any,
      }) as any;

      expect(socket.greet()).toBe('hello');
    });

    it('custom plugin has access to helpers', () => {
      class MyPlugin extends Plugin {
        id = 'my-plugin';
        capturedState: string | null = null;

        override install(_socket: Record<string, unknown>) {
          this.capturedState = this.helpers.getState();
        }
      }

      const plugin = new MyPlugin();
      createSocket('wss://example.com', { plugins: [plugin] as any });

      expect(plugin.capturedState).toBeDefined();
    });
  });

  describe('no plugins', () => {
    it('works with no options', () => {
      const socket = createSocket('wss://example.com');
      expect(socket).toBeDefined();
    });

    it('works with empty plugins array', () => {
      const socket = createSocket('wss://example.com', { plugins: [] as any });
      expect(socket).toBeDefined();
    });
  });
});
