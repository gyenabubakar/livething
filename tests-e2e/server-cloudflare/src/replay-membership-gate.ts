import { bind } from '@wskit/server-cloudflare';
import { replayMembershipGateDefinition } from '@wskit/tests-e2e-handlers/replay-membership-gate';

export class ReplayMembershipGateServer extends bind(replayMembershipGateDefinition) {}
