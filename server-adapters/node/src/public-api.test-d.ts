/* oxlint-disable no-unused-vars */

import * as Adapter from './index.ts';
import type { Platform } from './index.ts';

void Adapter.server;

declare const _platform: Platform;
void _platform;

// Internal value symbols must not be reachable from the package root.

// @ts-expect-error — createPlatform is internal
Adapter.createPlatform;
