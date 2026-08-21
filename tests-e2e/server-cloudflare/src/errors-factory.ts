import { server } from '@wskit/server-cloudflare';
import { errorsFactoryHandler } from '@wskit/tests-e2e-handlers/errors-factory';

export class ErrorsFactoryServer extends server(errorsFactoryHandler) {}
