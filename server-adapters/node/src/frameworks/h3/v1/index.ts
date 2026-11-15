import { defineEventHandler } from 'h3';
import { createH3V1Setup } from './setup.ts';
import type { H3V1Setup } from './setup.ts';

export type { H3V1Endpoint, H3V1EndpointOptions, H3V1Setup } from './setup.ts';

type H3V1Handler = ReturnType<typeof defineEventHandler>;

/** Creates H3 v1 route bindings without creating or listening on an HTTP server. */
export function setup(): H3V1Setup<H3V1Handler> {
  // This repo type-checks against h3 v2, whose overloads differ. `test:h3-packages` checks v1.
  return createH3V1Setup(defineEventHandler as Parameters<typeof createH3V1Setup<H3V1Handler>>[0]);
}
