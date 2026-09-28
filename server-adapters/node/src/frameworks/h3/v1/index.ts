import { defineWebSocketHandler } from 'h3';
import { createH3V1Setup } from './setup.ts';
import type { H3V1Setup } from './setup.ts';

export type { H3V1Endpoint, H3V1EndpointOptions, H3V1Setup } from './setup.ts';

/** Creates H3 v1 route bindings without creating or listening on an HTTP server. */
export function setup(): H3V1Setup<ReturnType<typeof defineWebSocketHandler>> {
  return createH3V1Setup(defineWebSocketHandler);
}
