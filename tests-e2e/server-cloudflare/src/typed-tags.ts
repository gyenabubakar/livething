import { bind } from '@wskit/server-cloudflare';
import { typedTagsDefinition } from '@wskit/tests-e2e-handlers/typed-tags';

export class TypedTagsServer extends bind(typedTagsDefinition) {}
