import { server } from '@wskit/server-cloudflare';
import { errorHookIsolationHandler } from './handler.ts';

export const ErrorHookIsolationServer = server(errorHookIsolationHandler);
