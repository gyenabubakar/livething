import { bind } from '@livething/server-cloudflare';
import { errorsFactoryDefinition } from '@livething/tests-e2e-handlers/errors-factory';

export class ErrorsFactoryServer extends bind(errorsFactoryDefinition) {}
