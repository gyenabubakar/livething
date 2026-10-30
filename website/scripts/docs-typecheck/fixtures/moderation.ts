import { localKey } from '@livething/server';

export const ModerationKey = localKey<{
  role: 'admin' | 'member' | 'guest';
  muted: boolean;
}>('moderation');
