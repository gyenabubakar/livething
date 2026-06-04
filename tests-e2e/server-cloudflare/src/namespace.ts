import { server } from '@wskit/server-cloudflare';
import { namespaceHandler } from '@wskit/tests-e2e-handlers/namespace';

export const NamespaceServer = server(namespaceHandler);
