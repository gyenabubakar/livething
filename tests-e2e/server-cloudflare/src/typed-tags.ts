import { bind } from '@livething/server-cloudflare';
import { typedTagsDefinition } from '@livething/tests-e2e-handlers/typed-tags';

export class TypedTagsServer extends bind(typedTagsDefinition) {}
