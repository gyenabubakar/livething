import { bind } from '@livething/server-cloudflare';
import {
  binaryDefinition,
  binaryHibernationDefinition,
} from '@livething/tests-e2e-handlers/binary';

export class BinaryServer extends bind(binaryDefinition) {}

export class BinaryHibernationServer extends bind(binaryHibernationDefinition) {}
