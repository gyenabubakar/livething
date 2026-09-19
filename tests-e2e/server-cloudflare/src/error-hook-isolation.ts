import { bind } from '@livething/server-cloudflare';
import { errorHookIsolationDefinition } from '@livething/tests-e2e-handlers/error-hook-isolation';

export class ErrorHookIsolationServer extends bind(errorHookIsolationDefinition) {}
