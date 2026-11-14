import {
  corsHeaders,
  ERROR_HEADER,
  errorAnswer,
  isStreamRequest,
  preflightAnswer,
  PROTOCOL_HEADER,
  SSE_HEADERS,
  sseCloseEvent,
} from '@livething/server/adapters';
import type { AuthDecision, ConnectionHandle, SseAnswer, SseHub } from '@livething/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { isSocketRejection, upgradeRejection } from './upgrade.ts';
import type { ConnectionTransport } from './socket.ts';

/** A request `handle` takes: from `node:http`, or from a `node:http2` compatibility server. */
export type NodeHttpRequest = IncomingMessage | Http2ServerRequest;

/**
 * A response `handle` writes: a `node:http` `ServerResponse`, or a `node:http2` compatibility
 * `Http2ServerResponse`. Only the members both have.
 */
export interface NodeHttpResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | string[]>): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(): unknown;
  end(chunk: string): unknown;
  destroy(): unknown;
  once(event: 'close' | 'drain', listener: () => void): unknown;
  off(event: 'close' | 'drain', listener: () => void): unknown;
  /** Only on `node:http`. HTTP/2 sends the headers with `writeHead`. */
  flushHeaders?(): void;
  readonly writableLength?: number;
}

/** What the SSE handler needs from its endpoint. */
export interface NodeSseDeps {
  /** `null` when the endpoint does not offer server-sent events. */
  hub: SseHub | null;
  originAllowed(request: NodeHttpRequest): boolean;
  authenticate(request: NodeHttpRequest, signal: AbortSignal): Promise<AuthDecision>;
  attach(transport: ConnectionTransport, decision: AuthDecision): ConnectionHandle;
}

/** Serves the stream `GET`, its `POST`s and the CORS preflight of one endpoint. */
export function createNodeSseHandler(
  deps: NodeSseDeps,
): (request: NodeHttpRequest, response: NodeHttpResponse) => Promise<void> {
  return async (request, response) => {
    const { hub } = deps;
    const origin = header(request, 'origin');
    if (!deps.originAllowed(request)) {
      writeAnswer(response, errorAnswer(403, 'origin', 'Origin not allowed'));
      return;
    }

    const cors = corsHeaders(origin);
    const stream = isStreamRequest(
      header(request, 'accept'),
      header(request, PROTOCOL_HEADER.toLowerCase()),
    );
    if (!hub || (request.method === 'GET' && !stream)) {
      writeAnswer(response, errorAnswer(426, 'not-offered', 'Upgrade Required'), cors);
      return;
    }

    if (request.method === 'OPTIONS' && origin !== null) {
      writeAnswer(response, preflightAnswer(origin));
      return;
    }

    if (request.method === 'GET') {
      await openStream(deps, { hub, request, response, cors });
      return;
    }

    if (request.method === 'POST') {
      writeAnswer(response, await post(hub, request), cors);
      return;
    }

    writeAnswer(
      response,
      { ...errorAnswer(405, 'method'), headers: { [ERROR_HEADER]: 'method', Allow: 'GET, POST' } },
      cors,
    );
  };
}

interface StreamRequest {
  hub: SseHub;
  request: NodeHttpRequest;
  response: NodeHttpResponse;
  cors: Record<string, string>;
}

async function openStream(deps: NodeSseDeps, stream: StreamRequest): Promise<void> {
  const { hub, request, response, cors } = stream;
  const abort = new AbortController();
  function onClose(): void {
    abort.abort();
  }

  response.once('close', onClose);
  let decision: AuthDecision;
  try {
    decision = await deps.authenticate(request, abort.signal);
  } finally {
    response.off('close', onClose);
  }

  if (abort.signal.aborted) return;

  if (decision.reject && !isSocketRejection(decision)) {
    const { status, body } = upgradeRejection(decision);
    writeAnswer(response, errorAnswer(status, 'auth', body), cors);
    return;
  }

  response.writeHead(200, { ...SSE_HEADERS, ...cors });
  if (decision.reject) {
    response.end(sseCloseEvent(decision.code!, decision.reason ?? 'Authentication rejected'));
    return;
  }

  // Send the headers now: the client waits for them before it reads any event.
  response.flushHeaders?.();
  const opened = hub.openStream({
    write: (chunk) => void response.write(chunk),
    end: () => void response.end(),
    terminate: () => void response.destroy(),
    bufferedAmount: () => response.writableLength ?? 0,
    backpressureSupported: true,
  });
  response.once('close', () => opened.ended());
  try {
    opened.attach(deps.attach(opened.socket, decision));
  } catch (error) {
    response.destroy();
    throw error;
  }
}

async function post(hub: SseHub, request: NodeHttpRequest): Promise<SseAnswer> {
  const length = Number(header(request, 'content-length') ?? 0);
  if (length > hub.maxPostBytes) return errorAnswer(413, 'too-large');

  const started = hub.beginPost(
    header(request, 'livething-secret'),
    header(request, 'livething-lane'),
  );
  if (!('finish' in started)) return started;

  const body = await readBody(request, hub.maxPostBytes);
  if (body === null) {
    started.cancel();
    return errorAnswer(413, 'too-large');
  }

  if (body === undefined) {
    started.cancel();
    return errorAnswer(400, 'aborted');
  }

  return started.finish(body);
}

/** The body, `null` when it is over the limit, or `undefined` when it did not arrive whole. */
async function readBody(
  request: NodeHttpRequest,
  limit: number,
): Promise<Uint8Array | null | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > limit) return null;

      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }

  const body = Buffer.concat(chunks);

  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function header(request: NodeHttpRequest, name: string): string | null {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function writeAnswer(
  response: NodeHttpResponse,
  answer: SseAnswer,
  extra: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(answer.status, { ...answer.headers, ...extra });
  if (answer.body === null) {
    response.end();
  } else {
    response.end(answer.body);
  }
}
