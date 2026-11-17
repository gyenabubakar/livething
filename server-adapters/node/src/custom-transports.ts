import type { CustomServerTransport, TransportEndpoint } from '@livething/server/adapters';
import type { NodeHttpRequest, NodeHttpResponse } from './http.ts';

/** What the custom transport handler needs from its endpoint. */
export interface NodeCustomTransportDeps {
  transports: readonly CustomServerTransport[];
  endpoint: TransportEndpoint;
  /** The Web request for a Node request, or `null` when its target is not valid. */
  toWebRequest(request: NodeHttpRequest, signal: AbortSignal): Request | null;
  /** Logs an error a transport's `handle()` threw. */
  logError(error: unknown): void;
  /** Aborts when the endpoint shuts down, which ends every request still open. */
  shutdownSignal: AbortSignal;
}

/**
 * Offers a request to each custom transport in list order. Returns `true` when one
 * answered it, and `false` when the request is for `http()` or no transport.
 */
export function createNodeCustomTransportHandler(
  deps: NodeCustomTransportDeps,
): (request: NodeHttpRequest, response: NodeHttpResponse) => Promise<boolean> {
  return async (request, response) => {
    const abort = new AbortController();
    function onClose(): void {
      abort.abort();
    }

    function onShutdown(): void {
      response.destroy();
    }

    response.once('close', onClose);
    deps.shutdownSignal.addEventListener('abort', onShutdown);

    const webRequest = deps.toWebRequest(request, abort.signal);
    if (webRequest === null) {
      response.off('close', onClose);
      deps.shutdownSignal.removeEventListener('abort', onShutdown);
      return false;
    }

    try {
      for (const transport of deps.transports) {
        const handled = transport.handle(webRequest, deps.endpoint);
        // A handle() that never ends must not keep a shutdown waiting.
        const answer = await Promise.race([handled, whenAborted(abort.signal)]);
        if (answer === ABORTED) {
          void handled.then((late) => late?.body?.cancel().catch(() => {}), deps.logError);
          return true;
        }

        if (answer !== null) {
          await writeResponse(response, answer, abort.signal);
          return true;
        }
      }
    } catch (error) {
      deps.logError(error);
      if (!response.headersSent) response.writeHead(500, {});
      response.end();
      return true;
    } finally {
      response.off('close', onClose);
      deps.shutdownSignal.removeEventListener('abort', onShutdown);
    }

    return false;
  };
}

const ABORTED = Symbol('aborted');

function whenAborted(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });
}

/**
 * Writes a Web response to a Node response, chunk by chunk, as the body produces it.
 * `closed` aborts when the Node response closes, so nothing waits on a dead response.
 */
async function writeResponse(
  response: NodeHttpResponse,
  answer: Response,
  closed: AbortSignal,
): Promise<void> {
  if (closed.aborted) {
    await answer.body?.cancel().catch(() => {});
    return;
  }

  const headers: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;

  response.writeHead(answer.status, headers);
  if (answer.body === null) {
    response.end();
    return;
  }

  // Send the headers now: a streaming client waits for them before it reads.
  response.flushHeaders?.();
  const reader = answer.body.getReader();
  function stop(): void {
    void reader.cancel().catch(() => {});
  }

  closed.addEventListener('abort', stop);

  try {
    while (!closed.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        response.end();
        return;
      }

      if (!response.write(chunk.value)) await drained(response, closed);
    }
  } catch {
    response.destroy();
  } finally {
    closed.removeEventListener('abort', stop);
  }
}

/** Waits until the response can take more data, or is closed. */
function drained(response: NodeHttpResponse, closed: AbortSignal): Promise<void> {
  if (closed.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    function done(): void {
      response.off('drain', done);
      closed.removeEventListener('abort', done);
      resolve();
    }

    response.once('drain', done);
    closed.addEventListener('abort', done);
  });
}
