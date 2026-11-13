import { adapter, createOriginCheck, resolveTransports } from '@livething/server/adapters';
import type {
  AdminOf,
  AuthDecision,
  ConnectionHandle,
  Engine,
  EngineRuntimeOptions,
  Logger,
  ServerDefinition,
  ServerTransport,
} from '@livething/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { PerMessageDeflateOptions } from 'ws';
import { createAsyncContext } from './async-context.ts';
import { createClientIpResolver } from './client-ip.ts';
import { requestToWebRequest } from './request.ts';
import { createRuntime } from './runtime.ts';
import { createConnectionBridge } from './socket.ts';
import type { NodeClientIpConfig } from './client-ip.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { ConnectionTransport } from './socket.ts';

/** The default `maxMessageBytes`: 32 MiB, Cloudflare's limit, so an app behaves the same on both. */
const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** `ws` keeps `maxPayload` as a 32-bit number, so a bigger value would turn off its limit. */
const MAX_WS_PAYLOAD = 2 ** 31 - 1;

/** A `maxMessageBytes` option with its default, checked so `ws` and the engine agree on it. */
export function resolveMaxMessageBytes(value: number | undefined, where: string): number {
  const bytes = value ?? DEFAULT_MAX_MESSAGE_BYTES;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_WS_PAYLOAD) {
    throw new Error(
      `[livething] ${where} maxMessageBytes must be a whole number of bytes from 1 to ${MAX_WS_PAYLOAD}, got ${bytes}.`,
    );
  }

  return bytes;
}

/** The `compression` option where LiveThing creates the `ws` server. */
export type NodeCompressionOption = boolean | { threshold?: number };

/** A `compression` option as the `perMessageDeflate` options of a `ws` server. */
export function resolveCompression(
  value: NodeCompressionOption | undefined,
  where: string,
): false | PerMessageDeflateOptions {
  if (value === undefined || value === false) return false;

  if (value !== true && (typeof value !== 'object' || value === null)) {
    throw new Error(
      `[livething] ${where} compression must be true, false or { threshold }, got ${String(value)}.`,
    );
  }

  const threshold = value === true ? 1024 : (value.threshold ?? 1024);
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw new Error(
      `[livething] ${where} compression.threshold must be a whole number of bytes from 0, got ${String(threshold)}.`,
    );
  }

  // Each message compresses alone, so a connection keeps no state from past messages.
  return { threshold, serverNoContextTakeover: true, clientNoContextTakeover: true };
}

/** Configuration shared by every Node framework endpoint. */
export interface NodeEndpointOptions extends Omit<NodeStorageOptions, 'logger'> {
  logger?: Logger;
  clientIp?: NodeClientIpConfig;
  /**
   * The largest message, in bytes, this endpoint receives or sends. A bigger incoming message
   * closes the socket with `1009`, and a bigger send throws. Default: 32 MiB. When the app,
   * Fastify or h3 creates the `ws` server, set its `maxPayload` to the same value.
   */
  maxMessageBytes?: number;
  /**
   * Browser origins, besides the server's own, that may connect, such as
   * `['http://localhost:5173']`. A request whose `Origin` header is neither the same
   * host and port as its `Host` header nor in this list gets a 403. A request with no
   * `Origin` header, such as one from a Node or mobile client, is not checked.
   */
  allowedOrigins?: readonly string[];
  /**
   * The transports this endpoint offers, such as `[websocket()]`. Default: WebSocket only.
   * The order does not matter. An empty list, a transport listed twice, or something
   * that is not a transport fails at startup.
   */
  transports?: readonly ServerTransport[];
}

const ORIGIN_REJECTION: AuthDecision = { reject: true, code: 403, reason: 'Origin not allowed' };

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
  decideNodeUpgrade(request: IncomingMessage, signal?: AbortSignal): Promise<AuthDecision>;
  decideWebUpgrade(request: Request, clientIp?: string): Promise<AuthDecision>;
  attachTransport(
    token: unknown,
    transport: ConnectionTransport,
    decision: AuthDecision,
  ): ConnectionHandle;
}

const buildEndpoint = adapter<NodeEndpointOptions, NodeEndpointInternals<unknown>>({
  id: 'node',
  asyncContextFactory: createAsyncContext,

  setup<TApi>(
    createEngine: (options: EngineRuntimeOptions) => Engine<TApi>,
    options: NodeEndpointOptions,
  ) {
    const maxMessageBytes = resolveMaxMessageBytes(options.maxMessageBytes, 'The endpoint');
    const resolveClientIp = createClientIpResolver(options.clientIp);
    const originAllowed = createOriginCheck(options.allowedOrigins);
    // ponytail: only checked for now; step 7 reads the result once sse() exists.
    resolveTransports(options.transports);

    const runtime = createRuntime({
      sql: options.sql,
      kv: options.kv,
      logger: options.logger,
    });
    const logger = runtime.logger;
    let shuttingDown = false;
    let shutdownPromise: Promise<void> | undefined;

    const engine = createEngine({
      logger,
      platform: runtime.platform,
      storage: runtime.storage,
      timers: runtime.timers,
      messageLimits: { receiveBytes: maxMessageBytes, sendBytes: maxMessageBytes },
    });

    async function decideNodeUpgrade(
      request: IncomingMessage,
      signal?: AbortSignal,
    ): Promise<AuthDecision> {
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

      if (!originAllowed(webRequest)) return ORIGIN_REJECTION;

      return engine.authenticate(webRequest);
    }

    async function decideWebUpgrade(request: Request, clientIp?: string): Promise<AuthDecision> {
      await ready;
      if (shuttingDown) throw new Error('[livething] Node endpoint is shutting down');

      if (!originAllowed(request)) return ORIGIN_REJECTION;

      const headers = new Headers(request.headers);
      headers.delete('LiveThing-Client-IP');
      if (clientIp !== undefined) headers.set('LiveThing-Client-IP', clientIp);

      return engine.authenticate(
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
