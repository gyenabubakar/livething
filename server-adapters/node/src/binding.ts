import type {
  ApiOf,
  ConnectionHandle,
  ServerDefinition,
  UpgradeDecision,
} from '@wskit/server/adapters';
import type { IncomingMessage } from 'node:http';
import { createNodeEndpoint } from './endpoint.ts';
import { createHttpRejectionResponse, isSocketRejection } from './upgrade.ts';
import type { NodeAdmin, NodeEndpointInternals, NodeEndpointOptions } from './endpoint.ts';

export type { NodeAdmin, NodeEndpointOptions } from './endpoint.ts';

/** A peer accepted by a host integration after its WebSocket handshake. */
export interface NodePeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
  backpressureSupported: boolean;
}

/** Forwards lifecycle events from an accepted peer to WSKit. */
export interface NodeConnection {
  message(data: string): Promise<void>;
  close(code: number, reason: string): Promise<void>;
  error(error: unknown): Promise<void>;
}

/** The possible result of checking a WebSocket upgrade with WSKit. */
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
  accept(peer: NodePeer): NodeConnection;
}

/** One WSKit definition prepared for a host integration to upgrade. */
export interface NodeBindingEndpoint<TApi = unknown> {
  ready(): Promise<void>;
  prepare(request: Request, options?: NodePrepareOptions): Promise<NodeUpgrade>;
  prepareNode(request: IncomingMessage, options?: { signal?: AbortSignal }): Promise<NodeUpgrade>;
  admin(): Promise<NodeAdmin<TApi>>;
}

/**
 * Metadata a Fetch-based host derived from its own trusted connection details.
 *
 * `prepare()` always removes a client-supplied `WSKit-Client-IP` header. Set
 * `clientIp` only after the host has derived it from a trusted peer or proxy.
 */
export interface NodePrepareOptions {
  clientIp?: string;
}

/** Shared lifecycle for Node host integrations. */
export interface NodeBinding {
  bind<THandler extends ServerDefinition>(
    handler: THandler,
    options: NodeEndpointOptions,
  ): NodeBindingEndpoint<ApiOf<THandler>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Creates the integration seam for a Node WebSocket host.
 *
 * This does not create, listen on, or close an HTTP server. A host integration
 * calls `prepare()` or `prepareNode()`, performs its own handshake, then passes
 * accepted peer events through the returned connection.
 */
export function binding(): NodeBinding {
  const endpoints = new Set<NodeEndpointInternals>();
  let shutdownPromise: Promise<void> | undefined;

  return {
    bind(handler, options) {
      if (shutdownPromise) throw new Error('[wskit] Node binding is shutting down');

      const endpoint = createNodeEndpoint(handler, options);
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

function createBindingEndpoint<TApi>(
  endpoint: NodeEndpointInternals<TApi>,
): NodeBindingEndpoint<TApi> {
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

function toNodeUpgrade<TApi>(
  decision: UpgradeDecision,
  endpoint: NodeEndpointInternals<TApi>,
): NodeUpgrade {
  if (!decision.reject) {
    let accepted = false;

    return {
      type: 'accept',
      accept(peer) {
        if (accepted) throw new Error('[wskit] an accepted upgrade can only attach one peer');

        accepted = true;

        return toNodeConnection(endpoint.attachTransport(peer, peer, decision));
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
    close: connection.handleClose,
    error: connection.handleError,
  };
}
