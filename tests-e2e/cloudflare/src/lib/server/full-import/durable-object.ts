import { serve } from '@wskit/server-cloudflare';
import { fullImportHandler } from './handler.ts';

export const FullImportServer = serve(fullImportHandler);
