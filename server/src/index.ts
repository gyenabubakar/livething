// New contract + implement API (primary surface)
export {
  channel,
  contract,
  error,
  group,
  implement,
  incoming,
  namespace,
  nudge,
  outgoing,
  request,
  scheduled,
  scope,
  stream,
  t,
  use,
} from './_api/index.ts';
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
} from './_api/index.ts';

export { event } from './event.ts';
export type { EventContract } from './event.ts';
export type { Validator } from './types.ts';

export type { ScopeDeclaration } from './channel/channel.ts';

export { defineModule, module } from './modules/index.ts';
export type {
  ModuleConfig,
  ModuleContextFactory,
  ModuleDependency,
  ModuleFactory,
  ModuleHooks,
  ModuleInstance,
} from './modules/index.ts';

export type { InferClient } from './infer-client.ts';

export type {
  BroadcastOptions,
  ChannelHandle,
  ChannelsManager,
  ConnectionContext,
  ConnectionInfo,
  ConnectionRef,
  InitContext,
  Logger,
  ReplayScopeSendApi,
  ScopeSendApi,
  ShutdownContext,
  TagRef,
  TaskContext,
} from './context.ts';
