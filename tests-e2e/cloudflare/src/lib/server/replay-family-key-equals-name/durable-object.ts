import { serve } from '@wskit/server-cloudflare';
import { replayFamilyKeyEqualsNameHandler } from './handler.ts';

export const ReplayFamilyKeyEqualsNameServer = serve(replayFamilyKeyEqualsNameHandler);
