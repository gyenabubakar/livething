/**
 * The intercepts capability, exposed on its own import path. List it in
 * `server({ capabilities: [...] })` to register `base.intercept(...)` handlers
 * that see frames before they dispatch.
 */
export { intercepts } from './capability.ts';
