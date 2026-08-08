import { server } from '@wskit/server-cloudflare';
import { errorHookIsolationHandler } from '@wskit/tests-e2e-handlers/error-hook-isolation';

export class ErrorHookIsolationServer extends server(errorHookIsolationHandler) {}
