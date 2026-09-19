import { bind } from '@livething/server-cloudflare';
import { replaySnapshotDefinition } from '@livething/tests-e2e-handlers/replay-snapshot';

export class ReplaySnapshotServer extends bind(replaySnapshotDefinition) {}
