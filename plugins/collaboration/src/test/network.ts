import type { TransportFactory } from '@livething/client';
import type { ConnectionHandle, Engine, TransportFrame } from '@livething/server/adapters';

/** One live connection between a client and the test engine. */
interface Link {
  readonly handle: ConnectionHandle;
  /** Close it as a dropped network does: no close frame, code 1006. */
  drop(): void;
}

/**
 * A network between test clients and one engine, in memory. Each client connects with
 * `network.transport(userId)`. `goOffline()` drops every connection and refuses new ones
 * until `goOnline()`, the way a lost network does.
 */
export function memoryNetwork(engine: Engine) {
  const links = new Set<Link>();
  let online = true;
  let dropping = 0;

  function transport(userId: string): TransportFactory {
    return {
      name: 'memory',
      open(options) {
        let open = false;
        let link: Link | null = null;
        let inbound: Promise<void> = Promise.resolve();

        function closed(code: number, reason: string): void {
          if (!open) return;

          open = false;
          if (link) links.delete(link);
          options.events.close(code, reason, code === 1000);
        }

        queueMicrotask(() => {
          if (!online) {
            options.events.close(1006, 'offline', false);
            return;
          }

          // Frames the server sends before the client hears `open` wait for it.
          let held: (string | ArrayBuffer)[] | null = [];
          const handle = engine.accept(Symbol(userId), {
            send(frame: TransportFrame) {
              const data = frame.kind === 'text' ? frame.text : frame.bytes.slice().buffer;
              if (held) held.push(data);
              else if (open) options.events.message(data);
            },
            close: (code: number, reason: string) => closed(code, reason),
            bufferedAmount: () => 0,
            userId,
          });
          const current: Link = {
            handle,
            drop() {
              void handle.handleClose(1006, '');
              closed(1006, '');
            },
          };

          link = current;
          links.add(current);

          open = true;
          options.events.open();
          const waiting = held;
          held = null;
          for (const data of waiting) options.events.message(data);
        });

        return {
          name: 'memory',
          protocol: '',
          webSocket: null,
          reportsStable: false,
          isOpen: () => open,
          send(data) {
            const handle = link?.handle;
            if (!open || !handle) return;

            if (typeof data !== 'string' && dropping > 0) {
              dropping -= 1;
              return;
            }

            // In order, as one socket delivers them.
            inbound = inbound.then(() =>
              typeof data === 'string'
                ? handle.handleMessage(data)
                : handle.handleBinaryMessage(new Uint8Array(data)),
            );
          },
          sendControl() {},
          bufferedAmount: () => 0,
          close(code = 1000, reason = '') {
            if (link) void link.handle.handleClose(code, reason);
            closed(code, reason);
          },
          dispose(code = 1000, reason = '') {
            if (link) void link.handle.handleClose(code, reason);
            open = false;
            if (link) links.delete(link);
          },
        };
      },
    };
  }

  return {
    transport,
    goOffline(): void {
      online = false;
      for (const link of [...links]) link.drop();
    },
    goOnline(): void {
      online = true;
    },
    /** Lose the next `count` binary messages a client sends, as a broken path could. */
    dropUpdates(count: number): void {
      dropping = count;
    },
  };
}
