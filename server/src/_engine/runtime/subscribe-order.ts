import type { RuntimeConnection } from './types.ts';

/** One subscribe running for one channel of one connection. */
export interface SubscribeAttempt {
  readonly key: string;
  readonly source: 'client' | 'server';
  /** A later request replaced it. It must not commit, answer the client or report an error. */
  abandoned: boolean;
  /** Its gates passed. From here it can't be abandoned, and later frames wait for its `onSubscribe`. */
  committed: boolean;
}

/** What later frames for a channel wait on while subscribes run. It opens when the last one ends. */
export interface SubscribeGate {
  readonly attempts: Set<SubscribeAttempt>;
  readonly opened: Promise<void>;
  readonly open: () => void;
}

export function subscribeKey(channelName: string, channelFamily: string | null): string {
  return JSON.stringify([channelFamily, channelName]);
}

function endAttempt(connection: RuntimeConnection, attempt: SubscribeAttempt): void {
  const gate = connection.pendingSubscribes?.get(attempt.key);
  if (!gate?.attempts.delete(attempt) || gate.attempts.size > 0) return;

  connection.pendingSubscribes?.delete(attempt.key);
  gate.open();
}

/** Stop the subscribes of a channel that can still be stopped. */
export function abandonSubscribes(
  connection: RuntimeConnection,
  key: string,
  matches: (attempt: SubscribeAttempt) => boolean = () => true,
): void {
  const attempts = connection.pendingSubscribes?.get(key)?.attempts;
  for (const attempt of [...(attempts ?? [])]) {
    if (attempt.committed || !matches(attempt)) continue;

    attempt.abandoned = true;
    endAttempt(connection, attempt);
  }
}

/**
 * Start a subscribe. A client's newer subscribe replaces its older one that is
 * still in `check`, so the last request wins. A server-started subscribe
 * replaces nothing, since the client's request is still waiting for its answer.
 */
export function beginSubscribe(
  connection: RuntimeConnection,
  key: string,
  source: SubscribeAttempt['source'],
): SubscribeAttempt {
  const gates = (connection.pendingSubscribes ??= new Map());
  let gate = gates.get(key);
  if (!gate) {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    gate = { attempts: new Set(), opened, open };
    gates.set(key, gate);
  }

  // Added first, so the gate stays closed for the frames behind the replaced subscribe.
  const attempt: SubscribeAttempt = { key, source, abandoned: false, committed: false };
  gate.attempts.add(attempt);
  if (source === 'client') {
    abandonSubscribes(connection, key, (other) => other !== attempt && other.source === 'client');
  }

  return attempt;
}

export function finishSubscribe(connection: RuntimeConnection, attempt: SubscribeAttempt): void {
  endAttempt(connection, attempt);
}

/** The client subscribe of this channel that hasn't committed yet, if any. */
export function pendingClientSubscribe(
  connection: RuntimeConnection,
  key: string,
): SubscribeAttempt | undefined {
  const attempts = connection.pendingSubscribes?.get(key)?.attempts ?? [];
  return [...attempts].find((attempt) => attempt.source === 'client' && !attempt.committed);
}

/** A closed connection has no more frames to order: release everything held behind its subscribes. */
export function releaseSubscribes(connection: RuntimeConnection): void {
  for (const [key, gate] of [...(connection.pendingSubscribes ?? [])]) {
    abandonSubscribes(connection, key);
    for (const attempt of [...gate.attempts]) endAttempt(connection, attempt);
  }
}
