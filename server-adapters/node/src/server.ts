import { createServer } from 'node:http';
import process from 'node:process';
import { adapter } from '@wskit/server/adapters';
import type {
  AdminContext,
  ApiOf,
  Engine,
  EngineRuntimeOptions,
  Logger,
  ServerDefinition,
} from '@wskit/server/adapters';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createAsyncContext } from './async-context.ts';
import { createRuntime } from './runtime.ts';
import { createWebSocketBridge } from './socket.ts';
import { createUpgradeHandler } from './upgrade.ts';
import type { NodeClientIpConfig } from './client-ip.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { NodeWebSocketServer } from './upgrade.ts';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

/** Configuration for an owned or externally managed Node HTTP server. */
export interface NodeServerOptions extends Omit<NodeStorageOptions, 'logger'> {
  /** Attach WSKit to an existing Node HTTP server, such as an Express server. */
  server?: Server;

  /** Create and listen on an owned HTTP server when `server` is omitted. */
  port?: number | string;

  /** Host passed to the owned HTTP server's `listen()` call. */
  host?: string;

  /** Logger used by the engine and Node runtime services. */
  logger?: Logger;

  /** Optional trusted-peer strategy for the `WSKit-Client-IP` request header. */
  clientIp?: NodeClientIpConfig;

  /** Inject a configured `ws` server for tests or advanced transport setup. */
  webSocketServer?: NodeWebSocketServer;

  /** Automatically drain the service when the Node process receives SIGINT or SIGTERM. */
  shutdownOnSignal?: boolean;
}

/** The in-process admin surface returned by a Node service. */
export type NodeAdmin<TApi = unknown> = AdminContext<Record<string, unknown>, unknown> & TApi;

/** The live service created by the Node adapter. */
export interface NodeServer<TApi = unknown> {
  readonly server: Server;
  readonly ready: Promise<void>;
  admin(): Promise<NodeAdmin<TApi>>;
  shutdown(): Promise<void>;
}

const buildServe = adapter<NodeServerOptions, NodeServer<unknown>>({
  id: 'node',
  asyncContextFactory: createAsyncContext,

  setup<TApi>(
    createEngine: (options: EngineRuntimeOptions) => Engine<TApi>,
    options: NodeServerOptions,
  ) {
    if (options.server && options.port !== undefined) {
      throw new TypeError('[wskit] Node server options cannot include both server and port.');
    }

    if (!options.server && options.port === undefined) {
      throw new TypeError('[wskit] Node server options need either server or port.');
    }

    const ownsServer = options.server === undefined;
    const server =
      options.server ??
      createServer((_request, response) => {
        response.statusCode = 404;
        response.end();
      });

    const runtime = createRuntime({
      server,
      sql: options.sql,
      kv: options.kv,
      logger: options.logger,
    });

    const logger = runtime.logger;
    let shuttingDown = false;
    let shutdownPromise: Promise<void> | undefined;
    const pendingUpgrades = new Set<Promise<void>>();
    const pendingUpgradeSockets = new Set<Duplex>();

    const signalHandlers = new Map<ShutdownSignal, () => void>();

    const engine = createEngine({
      logger,
      platform: runtime.platform,
      storage: runtime.storage,
      timers: runtime.timers,
    });

    const upgrade = createUpgradeHandler({
      engine,
      clientIp: options.clientIp,
      webSocketServer: options.webSocketServer,
      onAccepted(webSocket, _request, decision) {
        createWebSocketBridge({ engine, socket: webSocket, decision });
      },
    });

    function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      const task = ready
        .then(() => {
          if (shuttingDown) return;

          return upgrade(request, socket, head);
        })
        .catch((error: unknown) => {
          logger.error('[wskit] Node upgrade failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          socket.destroy();
        });

      // Upgrades can arrive while startup is still running; shutdown waits for them here.
      pendingUpgrades.add(task);
      pendingUpgradeSockets.add(socket);
      void task.finally(() => {
        pendingUpgrades.delete(task);
        pendingUpgradeSockets.delete(socket);
      });
    }

    server.on('upgrade', handleUpgrade);

    // The listener is attached immediately, but every upgrade waits for `ready`.
    const ready = (async () => {
      await engine.initialize();
      engine.reconcileConnections(new Set());
      await runtime.timers.start(() => engine.handleAlarm());
      if (!shuttingDown && ownsServer) {
        await listen(server, options.port!, options.host);
      }
    })();

    // Keep startup failures available through `ready` without creating an unhandled rejection.
    void ready.catch(() => {});

    function detachSignalHandlers(): void {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }

      signalHandlers.clear();
    }

    const service: NodeServer<TApi> = {
      server,
      ready,

      async admin() {
        await ready;
        return engine.admin() as NodeAdmin<TApi>;
      },

      shutdown() {
        if (shutdownPromise) return shutdownPromise;

        shuttingDown = true;
        detachSignalHandlers();
        server.off('upgrade', handleUpgrade);
        shutdownPromise = (async () => {
          // Stop new upgrades, then drain the ones that already passed the listener.
          for (const socket of pendingUpgradeSockets) socket.destroy();
          await Promise.all([...pendingUpgrades]);

          let startupError: unknown;
          try {
            await ready;
          } catch (error) {
            startupError = error;
          }

          try {
            if (startupError === undefined) {
              runtime.timers.stop();
              await runtime.timers.drain();
              await engine.handleShutdown({ terminal: true });
            }
          } finally {
            await runtime.close();
            if (ownsServer) await closeServer(server);
          }

          if (startupError !== undefined) throw startupError;
        })();

        return shutdownPromise;
      },
    };

    const shouldShutdownOnSignal = options.shutdownOnSignal ?? ownsServer;
    if (shouldShutdownOnSignal) {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        function handler(): void {
          void service.shutdown().catch((error: unknown) => {
            logger.error('[wskit] Node signal shutdown failed', {
              signal,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }

        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    return service;
  },
});

function listen(server: Server, port: number | string, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      server.off('error', onError);
      reject(error);
    }

    server.once('error', onError);
    server.listen({ port, host }, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Creates a Node service for a compiled WSKit server definition. */
export function server<THandler extends ServerDefinition>(
  handler: THandler,
  options: NodeServerOptions,
): NodeServer<ApiOf<THandler>> {
  return buildServe(handler, options) as unknown as NodeServer<ApiOf<THandler>>;
}
