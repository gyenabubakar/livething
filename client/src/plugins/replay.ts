import { Plugin } from '~/plugins/base.ts';

/**
 * Tracks sequence numbers on incoming messages. On reconnection, sends a
 * replay request to the server with the last-seen sequence number.
 *
 * Default: uses `_seq` field for sequence numbers. Sends
 * `{ event: "_replay", payload: { since: N } }` on reconnect.
 * Override `extractSequence` and `buildReplayRequest` to customize.
 */
export class Replay extends Plugin {
  id = 'replay';

  private lastSequence: number | null = null;

  /** Extract a sequence number from the payload. Return `null` to skip tracking. */
  extractSequence(_event: string, payload: unknown): number | null {
    const p = payload as Record<string, unknown>;
    return typeof p._seq === 'number' ? p._seq : null;
  }

  /** Build the replay request message sent on reconnection. */
  buildReplayRequest(lastSequence: number): { event: string; payload: unknown } {
    return { event: '_replay', payload: { since: lastSequence } };
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const seq = this.extractSequence(message.event, message.payload);
    if (seq !== null) {
      this.lastSequence = seq;
    }
    return message;
  }

  override onReconnect() {
    if (this.lastSequence === null) return null;
    return [this.buildReplayRequest(this.lastSequence)];
  }
}
