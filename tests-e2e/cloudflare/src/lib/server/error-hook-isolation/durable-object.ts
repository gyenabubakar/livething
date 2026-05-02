import { serve } from '@wskit/server-cloudflare';
import { errorHookIsolationHandler } from './handler.ts';

export const ErrorHookIsolationServer = serve(errorHookIsolationHandler);
