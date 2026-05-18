/**
 * `@wskit/server/full` — alias of `@wskit/server`.
 *
 * The new wskit API is feature-flat: every capability ships from the same
 * surface, and you opt in per feature on the contract config. This module
 * is kept as a thin alias for code that imports from `@wskit/server/full`.
 */

export {
  channel,
  contract,
  error,
  group,
  implement,
  incoming,
  module,
  namespace,
  nudge,
  outgoing,
  request,
  scheduled,
  scope,
  stream,
  t,
  use,
} from '~/index.ts';

export type {
  ChannelContract,
  ChannelCtx,
  Contract,
  ContractConfig,
  Ctx,
  Definition,
  GroupHandle,
  NamespaceContract,
  NamespaceCtx,
  TagRefHandle,
  TagsApi,
} from '~/index.ts';

export { event } from '~/event.ts';
