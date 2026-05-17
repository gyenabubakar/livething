import { serve } from '@wskit/server-cloudflare';
import { persistenceHandler } from './handler.ts';

export const PersistenceServer = serve(persistenceHandler);
