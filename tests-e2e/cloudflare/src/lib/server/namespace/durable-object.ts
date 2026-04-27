import { serve } from '@wskit/server-cloudflare';
import { namespaceHandler } from './handler.ts';

export const NamespaceServer = serve(namespaceHandler);
