import { serve } from '@wskit/server-cloudflare';
import { errorsFactoryHandler } from './handler.ts';

export const ErrorsFactoryServer = serve(errorsFactoryHandler);
