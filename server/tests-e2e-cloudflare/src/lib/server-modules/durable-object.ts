import { serve } from '@wskit/server-cloudflare';
import { modulesHandler } from './handler.ts';

export const ModulesServer = serve(modulesHandler, { hibernation: false });
