import { bind } from '@wskit/server-cloudflare';
import { errorHookIsolationDefinition } from '@wskit/tests-e2e-handlers/error-hook-isolation';

export class ErrorHookIsolationServer extends bind(errorHookIsolationDefinition) {}
