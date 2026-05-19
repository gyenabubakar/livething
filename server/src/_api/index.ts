/**
 * Public surface for the contract + implement API.
 */

export { contract } from './contract.ts';
export {
  channel,
  error,
  incoming,
  namespace,
  nudge,
  outgoing,
  recordedStream,
  request,
  resumableStream,
  scheduled,
  stream,
  t,
} from './definitions.ts';
export { scope } from '~/channel/channel.ts';
export {
  ChannelImplement,
  GroupBuilder,
  Implementer,
  NamespaceImplement,
  group,
  implement,
} from './implement.ts';

export type {
  ChannelDef,
  Definition,
  ErrorContractDef,
  IncomingDef,
  NamespaceDef,
  NudgeDef,
  OutgoingDef,
  RecordedStreamDef,
  RequestDef,
  ResumableStreamDef,
  ScheduledDef,
  StreamDef,
  TypeMarker,
} from './definitions.ts';
export type {
  ChannelContract,
  Contract,
  ContractConfig,
  NamespaceContract,
} from './contract-types.ts';
export type {
  ChannelCtx,
  Ctx,
  GroupHandle,
  NamespaceCtx,
  TagsApi,
  TagRefHandle,
} from './ctx-types.ts';
