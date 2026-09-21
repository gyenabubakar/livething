/* oxlint-disable no-unused-vars */

import { server } from '@livething/server';
import { setup } from './index.ts';

const definition = server({}).assemble({ handlers: [] });
const livething = setup();

livething.bind(definition, {});

// @ts-expect-error — H3 v1 does not expose the raw Node request needed to trust client IPs
livething.bind(definition, { clientIp: { mode: 'direct' } });
