// A long-polling transport built only from the public API, to prove a custom transport works.
// It carries text frames only, and like WebSocket it delivers at most once.
import { hasCapability } from '@livething/server/adapters';
import type { Transport, TransportFactory, TransportOpenOptions } from '@livething/client';
import type {
  AuthDecision,
  ConnectionHandle,
  ServerTransport,
  TransportEndpoint,
} from '@livething/server/adapters';

const TRANSPORT_HEADER = 'LiveThing-Transport';
const SECRET_HEADER = 'LiveThing-Secret';

interface CloseInfo {
  code: number;
  reason: string;
}

interface PollAnswer {
  frames: string[];
  close: CloseInfo | null;
}

interface ClientMessage {
  frames?: string[];
  close?: CloseInfo;
}

interface Session {
  frames: string[];
  wake: (() => void) | null;
  closed: CloseInfo | null;
  handle: ConnectionHandle | null;
}

/** Options of the test long-polling transport. */
interface LongPollingOptions {
  /** How long a poll waits for a frame before it answers with none. */
  pollMs?: number;
}

/** The server side: a poll `GET` waits for frames, and a `POST` carries the client's frames. */
export function longPollingServer(options: LongPollingOptions = {}): ServerTransport {
  const pollMs = options.pollMs ?? 20_000;
  const sessions = new Map<string, Session>();

  function finish(secret: string, close: CloseInfo): void {
    const session = sessions.get(secret);
    if (!session || session.closed) return;

    session.closed = close;
    session.wake?.();
    // Keep the session for one more poll, so the client reads the close.
    setTimeout(() => sessions.delete(secret), pollMs).unref?.();
    void session.handle?.handleClose(close.code, close.reason);
  }

  async function poll(secret: string, session: Session, signal: AbortSignal): Promise<Response> {
    if (session.frames.length === 0 && !session.closed && !signal.aborted) {
      await new Promise<void>((resolve) => {
        function wake(): void {
          clearTimeout(timer);
          signal.removeEventListener('abort', wake);
          resolve();
        }

        const timer = setTimeout(wake, pollMs);
        // The client went away: stop waiting.
        signal.addEventListener('abort', wake);
        session.wake = wake;
      });
      session.wake = null;
    }

    if (session.closed) sessions.delete(secret);

    const answer: PollAnswer = { frames: session.frames.splice(0), close: session.closed };

    return Response.json(answer);
  }

  async function open(request: Request, endpoint: TransportEndpoint): Promise<Response> {
    const decision: AuthDecision = await endpoint.authenticate(request);
    if (decision.reject) {
      const code = decision.code ?? 401;
      if (code < 1000) return new Response(decision.reason ?? null, { status: code });

      const answer: PollAnswer = { frames: [], close: { code, reason: decision.reason ?? '' } };
      return Response.json(answer);
    }

    const secret = crypto.randomUUID();
    const session: Session = { frames: [], wake: null, closed: null, handle: null };
    sessions.set(secret, session);
    session.handle = endpoint.accept(
      {
        send(frame) {
          if (session.closed || frame.kind !== 'text') return false;

          session.frames.push(frame.text);
          session.wake?.();
          return true;
        },
        close: (code = 1000, reason = '') => finish(secret, { code, reason }),
        bufferedAmount: () => session.frames.reduce((total, frame) => total + frame.length, 0),
        backpressureSupported: false,
        secret,
      },
      decision,
    );

    return poll(secret, session, request.signal);
  }

  async function receive(secret: string, session: Session, request: Request): Promise<Response> {
    const message = (await request.json()) as ClientMessage;
    for (const frame of message.frames ?? []) void session.handle?.handleMessage(frame);

    if (message.close) finish(secret, message.close);

    return new Response(null, { status: 204 });
  }

  return {
    name: 'long-polling',
    check(definition) {
      if (!hasCapability(definition, 'keepalive')) {
        throw new Error('longPollingServer() needs keepalive() in the server definition.');
      }
    },
    async handle(request, endpoint) {
      if (request.headers.get(TRANSPORT_HEADER) !== 'long-polling') return null;

      const secret = request.headers.get(SECRET_HEADER);
      if (secret === null) return open(request, endpoint);

      const session = sessions.get(secret);
      if (!session) return new Response(null, { status: 404 });

      return request.method === 'POST'
        ? receive(secret, session, request)
        : poll(secret, session, request.signal);
    },
  };
}

/** The client side of the test long-polling transport. */
export function longPollingClient(): TransportFactory {
  return { name: 'long-polling', open: openLongPolling };
}

function openLongPolling(options: TransportOpenOptions): Transport {
  const url = options.url.replace(/^ws/i, 'http');
  const abort = new AbortController();
  let state: 'connecting' | 'open' | 'closed' = 'connecting';
  let muted = false;
  let secret: string | null = null;

  let sending = Promise.resolve();

  function headers(): Record<string, string> {
    if (secret !== null) return { [TRANSPORT_HEADER]: 'long-polling', [SECRET_HEADER]: secret };

    return {
      [TRANSPORT_HEADER]: 'long-polling',
      ...(options.token === null ? {} : { Authorization: `Bearer ${options.token}` }),
    };
  }

  function end(info: CloseInfo, wasClean: boolean): void {
    if (state === 'closed') return;

    state = 'closed';
    abort.abort();
    if (!muted) options.events.close(info.code, info.reason, wasClean);
  }

  function read(frame: string): void {
    if (secret === null && frame.startsWith('["__connected__"')) {
      secret = (JSON.parse(frame) as [string, { secret: string }])[1].secret;
    }

    if (!muted) options.events.message(frame);
  }

  async function pollLoop(): Promise<void> {
    try {
      while (state !== 'closed') {
        const response = await fetch(url, { headers: headers(), signal: abort.signal });
        if (!response.ok) {
          end({ code: 1006, reason: `HTTP ${response.status}` }, false);
          return;
        }

        if (state === 'connecting') {
          state = 'open';
          if (!muted) options.events.open();
        }

        const answer = (await response.json()) as PollAnswer;
        for (const frame of answer.frames) read(frame);

        if (answer.close) end(answer.close, true);
      }
    } catch (error) {
      if (state === 'closed') return;

      if (!muted) options.events.error(error);
      end({ code: 1006, reason: '' }, false);
    }
  }

  function post(message: ClientMessage): void {
    sending = sending.then(async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });
        if (!response.ok) end({ code: 1006, reason: 'POST failed' }, false);
      } catch {
        end({ code: 1006, reason: 'POST failed' }, false);
      }
    });
  }

  function close(code = 1000, reason = ''): void {
    if (secret !== null && state === 'open') post({ close: { code, reason } });

    end({ code, reason }, true);
  }

  void pollLoop();

  return {
    name: 'long-polling',
    protocol: '',
    webSocket: null,
    reportsStable: false,
    isOpen: () => state === 'open',
    send(data) {
      if (typeof data !== 'string') throw new Error('The long-polling transport sends text only.');

      post({ frames: [data] });
    },
    sendControl: (frame) => post({ frames: [frame] }),
    bufferedAmount: () => 0,
    close,
    dispose(code, reason) {
      muted = true;
      close(code, reason);
    },
  };
}
