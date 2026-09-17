import { bind } from '@wskit/server-cloudflare';
import { replaySnapshotDefinition } from '@wskit/tests-e2e-handlers/replay-snapshot';

export class ReplaySnapshotServer extends bind(replaySnapshotDefinition) {}
