import type {
  ConnectionHandle,
  ServerDefinition,
  UpgradeDecision,
} from '@livething/server/adapters';
import type { IncomingMessage } from 'node:http';
import { createNodeEndpoint } from './endpoint.ts';
import { createHttpRejectionResponse, isSocketRejection } from './upgrade.ts';
import type { NodeAdmin, NodeEndpointInternals, NodeEndpointOptions } from './endpoint.ts';
import type { ConnectionTransport } from './socket.ts';

export { closeWebSocket } from './close.ts';
export type { ClosableWebSocket } from './close.ts';
export { createUpgradeLifecycle } from './upgrade-lifecycle.ts';
export type { UpgradeLifecycle } from './upgrade-lifecycle.ts';

export type { NodeAdmin, NodeEndpointOptions } from './endpoint.ts';
export type { ConnectionTransport } from './socket.ts';

/** Forwards lifecycle events from an accepted transport to LiveThing. */
export interface NodeConnection {
  message(data: string): Promise<void>;
  /** A binary message, as a plain `Uint8Array` view of its bytes. */
  binaryMessage(data: Uint8Array): Promise<void>;
  close(code: number, reason: string): Promise<void>;
  error(error: unknown): Promise<void>;
}

/** The possible result of checking a WebSocket upgrade with LiveThing. */
export type NodeUpgrade = NodeHttpRejection | NodeSocketRejection | NodeAcceptedUpgrade;

/** An upgrade rejected as an HTTP response before a WebSocket handshake. */
export interface NodeHttpRejection {
  type: 'http';
  response: Response;
}

/** An upgrade that must complete the handshake, then close the WebSocket. */
export interface NodeSocketRejection {
  type: 'socket';
  code: number;
  reason: string;
}

/** An accepted upgrade. Call `accept()` once after the host accepts the WebSocket. */
export interface NodeAcceptedUpgrade {
  type: 'accept';
  accept(transport: ConnectionTransport): NodeConnection;
}

/** One LiveThing definition prepared for a host integration to upgrade. */
export interface NodeBindingEndpoint<TAdmin = NodeAdmin> {
  ready(): Promise<void>;
  prepare(request: Request, options?: NodePrepareOptions): Promise<NodeUpgrade>;
  prepareNode(request: IncomingMessage, options?: { signal?: AbortSignal }): Promise<NodeUpgrade>;
  admin(): Promise<TAdmin>;
}

/**
 * Metadata a Fetch-based host derived from its own trusted connection details.
 *
 * `prepare()` always removes a client-supplied `LiveThing-Client-IP` header. Set
 * `clientIp` only after the host has derived it from a trusted peer or proxy.
 */
export interface NodePrepareOptions {
  clientIp?: string;
}

/** Shared lifecycle for Node host integrations. */
export interface NodeBinding {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ): NodeBindingEndpoint<NodeAdmin<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Creates the integration seam for a Node WebSocket host.
 *
 * This does not create, listen on, or close an HTTP server. A host integration
 * calls `prepare()` or `prepareNode()`, performs its own handshake, then passes
 * accepted transport events through the returned connection. Both run the
 * definition's `upgrade` hook, so call them only for a WebSocket upgrade request.
 */
export function binding(): NodeBinding {
  const endpoints = new Set<NodeEndpointInternals>();
  let shutdownPromise: Promise<void> | undefined;

  return {
    bind(definition, options) {
      if (shutdownPromise) throw new Error('[livething] Node binding is shutting down');

      const endpoint = createNodeEndpoint(definition, options);
      endpoints.add(endpoint);
      return createBindingEndpoint(endpoint);
    },

    ready() {
      return Promise.all([...endpoints].map((endpoint) => endpoint.ready)).then(() => {});
    },

    shutdown() {
      if (!shutdownPromise) {
        shutdownPromise = Promise.all([...endpoints].map((endpoint) => endpoint.shutdown())).then(
          () => {},
        );
      }

      return shutdownPromise;
    },
  };
}

function createBindingEndpoint<TAdmin>(
  endpoint: NodeEndpointInternals<TAdmin>,
): NodeBindingEndpoint<TAdmin> {
  return {
    ready: () => endpoint.ready,
    async prepare(request, options) {
      return toNodeUpgrade(await endpoint.decideWebUpgrade(request, options?.clientIp), endpoint);
    },
    async prepareNode(request, options) {
      return toNodeUpgrade(await endpoint.decideNodeUpgrade(request, options?.signal), endpoint);
    },
    admin: endpoint.admin,
  };
}

function toNodeUpgrade<TAdmin>(
  decision: UpgradeDecision,
  endpoint: NodeEndpointInternals<TAdmin>,
): NodeUpgrade {
  if (!decision.reject) {
    let accepted = false;

    return {
      type: 'accept',
      accept(transport) {
        if (accepted) {
          throw new Error('[livething] an accepted upgrade can only attach one transport');
        }

        accepted = true;

        return toNodeConnection(endpoint.attachTransport(transport, transport, decision));
      },
    };
  }

  if (isSocketRejection(decision)) {
    return {
      type: 'socket',
      code: decision.code!,
      reason: decision.reason ?? 'Upgrade rejected',
    };
  }

  return { type: 'http', response: createHttpRejectionResponse(decision) };
}

function toNodeConnection(connection: ConnectionHandle): NodeConnection {
  return {
    message: connection.handleMessage,
    binaryMessage: connection.handleBinaryMessage,
    close: connection.handleClose,
    error: connection.handleError,
  };
}
