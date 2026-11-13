import { bindFixture } from './bind-fixture.ts';
import { heartbeatHibernationDefinition } from './heartbeat-hibernation/handler.ts';

export class HeartbeatHibernationServer extends bindFixture(heartbeatHibernationDefinition) {}
