import { server } from '@wskit/server-cloudflare';
import { errorsFactoryHandler } from './handler.ts';

export const ErrorsFactoryServer = server(errorsFactoryHandler);
