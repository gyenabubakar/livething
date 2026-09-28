import { defineWebSocketHandler } from 'h3';
import { createH3Setup } from './setup.ts';
import type { H3Setup } from './setup.ts';

export type { H3Endpoint, H3Setup } from './setup.ts';

/** Creates H3 route bindings without creating or listening on an HTTP server. */
export function setup(): H3Setup<ReturnType<typeof defineWebSocketHandler>> {
  return createH3Setup(defineWebSocketHandler);
}
