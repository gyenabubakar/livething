/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: @wskit/server-cloudflare public API surface.
 *
 * Value export boundaries are checked via namespace property access so
 * Prettier cannot merge the @ts-expect-error comments away. Type-only
 * boundaries (CloudflareDurableObjectClass, WSKitDurableObjectInstance)
 * are enforced by the explicit export list in index.ts.
 */

import * as Adapter from './index.ts';
import type { Platform } from './index.ts';

void Adapter.bind;

declare const _platform: Platform;
void _platform;

// Internal value symbols must NOT be reachable from the package root.

// @ts-expect-error — createPlatform is internal
Adapter.createPlatform;

// @ts-expect-error — createStorage is internal
Adapter.createStorage;

// @ts-expect-error — createTimers is internal
Adapter.createTimers;
