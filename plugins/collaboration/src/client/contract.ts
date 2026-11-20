import type { InferPluginClient } from '@livething/server/plugins';
import type { DocDef } from '~/schema.ts';
import type { collaboration } from '~/server/plugin.ts';

/** What the server plugin offers a client: the `docs` family, its binary messages and errors. */
export type CollaborationWire = InferPluginClient<
  ReturnType<typeof collaboration<readonly DocDef[]>>
>;
