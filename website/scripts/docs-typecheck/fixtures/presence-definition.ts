// A second Huddle server definition, for the pages that run several definitions in one app.
import { emits, server, t } from '@livething/server';

const base = server({
  capabilities: [emits({ 'presence-changed': t<{ userId: string; online: boolean }>() })],
});

export const presence = base.assemble({ handlers: [] });
