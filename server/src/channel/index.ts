/**
 * The channels capability, exposed on its own import path. List it in
 * `server({ capabilities: [...] })` to enable `base.channel(...)`, membership
 * and presence, and dynamic channel families.
 */
export { channels } from './capability.ts';
export type { ChannelsCapability } from './capability.ts';
