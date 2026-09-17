import { bind } from '@wskit/server-cloudflare';
import { errorsFactoryDefinition } from '@wskit/tests-e2e-handlers/errors-factory';

export class ErrorsFactoryServer extends bind(errorsFactoryDefinition) {}
