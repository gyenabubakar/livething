import { bind } from '@livething/server-cloudflare';
import { replayMembershipGateDefinition } from '@livething/tests-e2e-handlers/replay-membership-gate';

export class ReplayMembershipGateServer extends bind(replayMembershipGateDefinition) {}
