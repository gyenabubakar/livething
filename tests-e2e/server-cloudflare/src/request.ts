import { bind } from '@wskit/server-cloudflare';
import { requestHandler } from '@wskit/tests-e2e-handlers/request';

export class RequestServer extends bind(requestHandler) {}
