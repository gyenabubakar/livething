import { incoming } from '~/incoming/incoming.ts';
import { intercept } from '~/intercept/intercept.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { request } from '~/request/request.ts';
import { generate, nudge, start, stream } from '~/stream/stream.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { namespace } from './namespace.ts';

describe('namespace', () => {
  it('creates a frozen namespace primitive for mixed child primitives', () => {
    const streamDecl = stream(start('ai', v.object({ prompt: v.string() })), nudge('stop'));
    const primitive = namespace(
      'notifications',
      outgoing('message'),
      intercept((_ctx, frame) => frame.payload),
      incoming('send-message', async () => {}),
      request('status', async () => {}),
      generate(streamDecl, async function* () {
        yield { token: 'x' };
      }),
    );

    expect(primitive.__wskit).toBe('namespace');
    expect(primitive.__kind).toBe('scope');
    expect(primitive.__identity[1]).toBe('notifications');
    expect(primitive.pattern).toBe('notifications');
    expect(Object.isFrozen(primitive.primitives)).toBe(true);
    expect(primitive.primitives).toHaveLength(5);
  });
});
