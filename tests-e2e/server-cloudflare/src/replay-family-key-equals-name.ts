import { server } from '@wskit/server-cloudflare';
import { replayFamilyKeyEqualsNameHandler } from '@wskit/tests-e2e-handlers/replay-family-key-equals-name';

export class ReplayFamilyKeyEqualsNameServer extends server(replayFamilyKeyEqualsNameHandler) {}
