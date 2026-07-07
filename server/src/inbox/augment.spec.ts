import { buildChannelHandle } from '~/channel/context.ts';
import { ensureSequenceSchema } from '~/sequence/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type {
  ChannelHandleAugmenter,
  ResolvedInboxOptions,
} from '~/_engine/runtime/feature-slots.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import { registerInboxHandleAugmenter } from './augment.ts';
import { registerReadReceiptsHandleAugmenter } from './read-receipts-augment.ts';
import { ensureReceiptsSchema } from './receipts-storage.ts';
import { ensureInboxSchema } from './storage.ts';
import { createTestSql } from './test-sql.ts';

const INBOX_OPTIONS: ResolvedInboxOptions = {
  onDelivered: 'delete',
  broadcastReceipts: false,
  maxReceiptAudience: 256,
};

function augmenterEngine(opts: { inboxChannels: Set<string>; readReceiptsChannels: Set<string> }) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  ensureReceiptsSchema(sql);
  ensureSequenceSchema(sql);

  const augmenters: ChannelHandleAugmenter[] = [];
  const engine = {
    installOnce: (_key: symbol, run: () => void) => run(),
    addChannelHandleAugmenter: (augmenter: ChannelHandleAugmenter) => augmenters.push(augmenter),
    getInboxChannel: (channelKey: string) =>
      opts.inboxChannels.has(channelKey) ? INBOX_OPTIONS : undefined,
    hasReadReceiptsChannel: (channelKey: string) => opts.readReceiptsChannels.has(channelKey),
    requireStorage: () => ({ sql }),
    isIdentityOnline: () => false,
    getLastSeenService: () => undefined,
  } as unknown as EngineAccess;

  registerInboxHandleAugmenter(engine);
  registerReadReceiptsHandleAugmenter(engine);
  return { augmenters, sql };
}

function handleFor(
  augmenters: readonly ChannelHandleAugmenter[],
  scope: { channelName: string; channelFamily: string | null },
) {
  const deps = {
    channelHandleAugmenters: augmenters,
    broadcastToChannel: () => {},
    getChannelMembers: () => [],
    kickChannelMembers: () => Promise.resolve(),
    removeChannelMember: () => Promise.resolve(),
    sendThroughPipeline: () => true,
    subscribeConnectionAsServer: () => Promise.resolve(),
  } as unknown as Parameters<typeof buildChannelHandle>[2];
  const connection = { id: 'c1' } as unknown as EngineRuntimeTypes.RuntimeConnection;
  return buildChannelHandle(connection, scope, deps);
}

describe('inbox handle-augmenter', () => {
  it('returns the inbox surface from ctx.channels.get(name).inbox() for an inbox channel', () => {
    const { augmenters } = augmenterEngine({
      inboxChannels: new Set(['room']),
      readReceiptsChannels: new Set(),
    });
    const handle = handleFor(augmenters, { channelName: 'room', channelFamily: null });

    const surface = handle.inbox();
    expect(surface).not.toBeNull();
    expect(typeof surface!.backfill).toBe('function');
    expect(typeof surface!.receiversOf).toBe('function');
    expect(typeof surface!.backlog).toBe('function');
    expect(surface!.backlog()).toEqual([]);
  });

  it('returns null from inbox() for a channel without inbox', () => {
    const { augmenters } = augmenterEngine({
      inboxChannels: new Set(['room']),
      readReceiptsChannels: new Set(),
    });
    const handle = handleFor(augmenters, { channelName: 'other', channelFamily: null });
    expect(handle.inbox()).toBeNull();
  });

  it('resolves inbox by channel family key for a dynamic channel', () => {
    const { augmenters } = augmenterEngine({
      inboxChannels: new Set(['rooms']),
      readReceiptsChannels: new Set(),
    });
    const handle = handleFor(augmenters, { channelName: 'rooms:abc', channelFamily: 'rooms' });
    expect(handle.inbox()).not.toBeNull();
  });

  it('returns the read-receipts surface only for a readReceipts channel', () => {
    const { augmenters } = augmenterEngine({
      inboxChannels: new Set(['room']),
      readReceiptsChannels: new Set(['room']),
    });
    const room = handleFor(augmenters, { channelName: 'room', channelFamily: null });
    const other = handleFor(augmenters, { channelName: 'other', channelFamily: null });

    expect(room.readReceipts()).not.toBeNull();
    expect(typeof room.readReceipts()!.readersOf).toBe('function');
    expect(other.readReceipts()).toBeNull();
  });
});
