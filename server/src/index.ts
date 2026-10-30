export { error, t } from './_api/definitions.ts';

export type {
  FrameOwner,
  InterceptFrame,
  InterceptRouting,
  OutgoingFrame,
  OutgoingTarget,
} from './intercept/intercept.ts';

export { localKey } from './local-key/local-key.ts';
export type { LocalKey } from './local-key/local-key.ts';

export type { RateLimitConfig } from './rate-limit/rate-limit.ts';

export type { Validator } from './types.ts';

export type { ScopeDeclaration } from './channel/channel.ts';

export { context } from './ambient-context.ts';
export { server } from './_define/server.ts';
export type {
  Base,
  CoreBase,
  ServerConfig,
  IncomingHandlerValue,
  OnConfig,
  RequestConfig,
  RequestHandlerValue,
  ScopedServerConfig,
  ScopedUpgradeFn,
  UpgradeFn,
  UpgradeReturn,
} from './_define/server.ts';
export type { AppCtx } from './_define/app-ctx.ts';
export type { Capability, Contribution } from './_define/capability.ts';
export { emits } from './emits/emits.ts';
export type { EmitDefs } from './emits/emits.ts';
export { errors } from './errors/capability.ts';

export type { InferClient } from './infer-client.ts';

export type {
  BroadcastOptions,
  ChannelHandle,
  ChannelRecipient,
  ChannelsManager,
  ConnectionContext,
  ConnectionHandle,
  ConnectionInfo,
  ConnectionlessContext,
  ConnectionRef,
  ConnectionsManager,
  InitContext,
  Logger,
  ReplayScopeSendApi,
  ScopeSendApi,
  SQLProvider,
  SqlResult,
  TagRef,
  UserHandle,
  UserInfo,
  UserRef,
  UsersManager,
} from './context.ts';
