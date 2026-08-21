import { server } from '@wskit/server-cloudflare';
import { replaySnapshotHandler } from '@wskit/tests-e2e-handlers/replay-snapshot';

export class ReplaySnapshotServer extends server(replaySnapshotHandler) {}
