import { Replay } from '@/plugins/replay.ts';
import { describe, expect, it } from 'vitest';

describe('Replay', () => {
  it('tracks sequence numbers from incoming messages', () => {
    const replay = new Replay();
    replay.onIncoming({ event: 'msg', payload: { _seq: 5, text: 'hi' } });
    replay.onIncoming({ event: 'msg', payload: { _seq: 10, text: 'hello' } });

    const messages = replay.onReconnect();
    expect(messages).toEqual([{ event: '_replay', payload: { since: 10 } }]);
  });

  it('ignores messages without _seq', () => {
    const replay = new Replay();
    replay.onIncoming({ event: 'msg', payload: { text: 'no seq' } });

    expect(replay.onReconnect()).toBeNull();
  });

  it('returns null on reconnect when no sequences have been seen', () => {
    const replay = new Replay();
    expect(replay.onReconnect()).toBeNull();
  });

  it('passes through all messages unchanged', () => {
    const replay = new Replay();
    const msg = { event: 'msg', payload: { _seq: 1, data: 'test' } };
    expect(replay.onIncoming(msg)).toEqual(msg);

    const noSeq = { event: 'msg', payload: { data: 'no seq' } };
    expect(replay.onIncoming(noSeq)).toEqual(noSeq);
  });

  it('extractSequence returns number or null', () => {
    const replay = new Replay();
    expect(replay.extractSequence('msg', { _seq: 42 })).toBe(42);
    expect(replay.extractSequence('msg', { data: 'hi' })).toBeNull();
    expect(replay.extractSequence('msg', { _seq: 'not a number' })).toBeNull();
  });
});
