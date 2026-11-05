import { bind } from '@livething/server-cloudflare';
import { binaryDefinition } from '@livething/tests-e2e-handlers/binary';

export class BinaryServer extends bind(binaryDefinition) {}
