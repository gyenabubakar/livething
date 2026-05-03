import { serve } from '@wskit/server-cloudflare';
import { staticVsFamilyIsolationHandler } from './handler.ts';

export const StaticVsFamilyIsolationServer = serve(staticVsFamilyIsolationHandler);
