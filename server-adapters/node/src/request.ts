import type { NodeHttpRequest } from './http.ts';

/** Optional request metadata supplied while adapting a Node upgrade. */
export interface WebRequestOptions {
  signal?: AbortSignal;
  clientIp?: string;
  /** Give the request a body that reads the Node request when it is first read. */
  withBody?: boolean;
}

/** Converts Node's incoming upgrade request into the standard Web API shape. */
export function requestToWebRequest(
  request: NodeHttpRequest,
  options: WebRequestOptions = {},
): Request {
  const { signal, clientIp } = options;
  const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
  const protocol = encrypted ? 'https' : 'http';
  // HTTP/2 names the target in `:authority`, and RFC 9113 §8.3.1 says `Host` must not
  // override it.
  const authority = request.headers[':authority'];
  const host = typeof authority === 'string' ? authority : (request.headers.host ?? 'localhost');
  const target = request.url ?? '/';

  const base = new URL(`${protocol}://${host}`);

  // WHATWG URL parsing treats backslashes as authority separators in special URLs.
  if (target.includes('\\')) {
    throw new TypeError('[livething] request target contains a backslash');
  }

  const url = new URL(target.startsWith('//') ? `${base.origin}${target}` : target, base);
  if (url.origin !== base.origin) {
    throw new TypeError('[livething] request target authority does not match Host');
  }

  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    // HTTP/2 pseudo-headers such as `:path` are not headers, and `Headers` refuses them.
    if (value === undefined || name.startsWith(':')) continue;

    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  // The origin check and `authenticate` read `Host`, so it names the same target as the URL.
  if (typeof authority === 'string') headers.set('host', authority);

  headers.delete('LiveThing-Client-IP');
  if (clientIp !== undefined) headers.set('LiveThing-Client-IP', clientIp);

  const method = request.method ?? 'GET';
  const hasBody = options.withBody === true && method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body: hasBody ? lazyBody(request) : null,
    signal,
  };

  // Node needs `duplex` for a stream body.
  if (hasBody) init.duplex = 'half';

  return new Request(url, init);
}

/** A stream that starts reading the Node request only when someone reads it. */
function lazyBody(request: AsyncIterable<Buffer>): ReadableStream<Uint8Array> {
  let chunks: AsyncIterator<Buffer> | undefined;

  return new ReadableStream(
    {
      async pull(controller) {
        chunks ??= request[Symbol.asyncIterator]();
        const next = await chunks.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(
            new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength),
          );
        }
      },
      async cancel() {
        await chunks?.return?.();
      },
    },
    // With the default of 1, the stream pulls a chunk as soon as it is made, before anyone reads.
    { highWaterMark: 0 },
  );
}
