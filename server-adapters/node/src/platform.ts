/** Node-specific state shared by one WSKit endpoint. */
export interface Platform {}

/** Creates the Node-specific value exposed through `ctx.platform`. */
export function createPlatform(): Platform {
  return {};
}
