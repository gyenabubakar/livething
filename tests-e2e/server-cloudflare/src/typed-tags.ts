import { server } from '@wskit/server-cloudflare';
import { typedTagsHandler } from '@wskit/tests-e2e-handlers/typed-tags';

export class TypedTagsServer extends server(typedTagsHandler) {}
