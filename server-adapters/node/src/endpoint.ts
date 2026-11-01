import { adapter } from '@livething/server/adapters';
import type {
  AdminOf,
  ConnectionHandle,
  Engine,
  EngineRuntimeOptions,
  Logger,
  ServerDefinition,
  UpgradeDecision,
} from '@livething/server/adapters';
import type { IncomingMessage } from 'node:http';
import { createAsyncContext } from './async-context.ts';
import { createClientIpResolver } from './client-ip.ts';
import { requestToWebRequest } from './request.ts';
import { createRuntime } from './runtime.ts';
import { createConnectionBridge } from './socket.ts';
import type { NodeClientIpConfig } from './client-ip.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { ConnectionTransport } from './socket.ts';

/** Configuration shared by every Node framework endpoint. */
export interface NodeEndpointOptions extends Omit<NodeStorageOptions, 'logger'> {
  logger?: Logger;
  clientIp?: NodeClientIpConfig;
}

/**
 * The in-process admin surface for one Node endpoint: the definition's
 * connectionless `ctx`, typed against its own emits, plus the app's `api` methods.
 */
export type NodeAdmin<TDefinition extends ServerDefinition = ServerDefinition> =
  AdminOf<TDefinition>;

/** One initialized LiveThing endpoint, independent of any HTTP server. */
interface NodeEndpoint<TAdmin = NodeAdmin> {
  readonly ready: Promise<void>;
  admin(): Promise<TAdmin>;
  shutdown(): Promise<void>;
}

/** Internal endpoint operations used by framework route bindings. */
export interface NodeEndpointInternals<TAdmin = NodeAdmin> extends NodeEndpoint<TAdmin> {
  decideNodeUpgrade(request: IncomingMessage, signal?: AbortSignal): Promise<UpgradeDecision>;
  decideWebUpgrade(request: Request, clientIp?: string): Promise<UpgradeDecision>;
  attachTransport(
    token: unknown,
    transport: ConnectionTransport,
    decision: UpgradeDecision,
  ): ConnectionHandle;
}

const buildEndpoint = adapter<NodeEndpointOptions, NodeEndpointInternals<unknown>>({
  id: 'node',
  asyncContextFactory: createAsyncContext,

  setup<TApi>(
    createEngine: (options: EngineRuntimeOptions) => Engine<TApi>,
    options: NodeEndpointOptions,
  ) {
    const runtime = createRuntime({
      sql: options.sql,
      kv: options.kv,
      logger: options.logger,
    });
    const logger = runtime.logger;
    const resolveClientIp = createClientIpResolver(options.clientIp);
    let shuttingDown = false;
    let shutdownPromise: Promise<void> | undefined;

    const engine = createEngine({
      logger,
      platform: runtime.platform,
      storage: runtime.storage,
      timers: runtime.timers,
    });

    async function decideNodeUpgrade(
      request: IncomingMessage,
      signal?: AbortSignal,
    ): Promise<UpgradeDecision> {
      await ready;
      if (shuttingDown) throw new Error('[livething] Node endpoint is shutting down');

      let webRequest: Request;
      try {
        webRequest = requestToWebRequest(request, {
          clientIp: resolveClientIp(request),
          signal,
        });
      } catch {
        return { reject: true, code: 400, reason: 'Invalid upgrade request' };
      }

      return engine.handleUpgrade(webRequest);
    }

    async function decideWebUpgrade(request: Request, clientIp?: string): Promise<UpgradeDecision> {
      await ready;
      if (shuttingDown) throw new Error('[livething] Node endpoint is shutting down');

      const headers = new Headers(request.headers);
      headers.delete('LiveThing-Client-IP');
      if (clientIp !== undefined) headers.set('LiveThing-Client-IP', clientIp);

      return engine.handleUpgrade(
        new Request(request.url, {
          method: request.method,
          headers,
          signal: request.signal,
        }),
      );
    }

    const ready = (async () => {
      await engine.initialize();
      engine.reconcileConnections(new Set());
      await runtime.timers.start(() => engine.handleAlarm());
    })();
    void ready.catch(() => {});

    return {
      ready,
      decideNodeUpgrade,
      decideWebUpgrade,

      attachTransport(token, transport, decision) {
        if (shuttingDown) throw new Error('[livething] Node endpoint is shutting down');

        return createConnectionBridge({ engine, token, transport, decision });
      },

      async admin() {
        await ready;
        return engine.admin();
      },

      shutdown() {
        if (shutdownPromise) return shutdownPromise;

        shuttingDown = true;
        shutdownPromise = (async () => {
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
          }

          if (startupError !== undefined) throw startupError;
        })();

        return shutdownPromise;
      },
    };
  },
});

/** Creates one Node endpoint for a compiled LiveThing server definition. */
export function createNodeEndpoint<TDefinition extends ServerDefinition>(
  definition: TDefinition,
  options: NodeEndpointOptions,
): NodeEndpointInternals<NodeAdmin<TDefinition>> {
  return buildEndpoint(definition, options) as unknown as NodeEndpointInternals<
    NodeAdmin<TDefinition>
  >;
}
