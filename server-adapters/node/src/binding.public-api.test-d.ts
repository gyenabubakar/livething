/* oxlint-disable no-unused-vars */

import { server } from '@livething/server';
import * as Binding from './binding.ts';

const definition = server({}).assemble({ handlers: [] });
const node = Binding.binding();
const endpoint = node.bind(definition, {});
await endpoint.ready();
const upgrade = await endpoint.prepare(new Request('https://example.test/socket'));

if (upgrade.type === 'accept') {
  const connection = upgrade.accept({
    send() {},
    close() {},
    bufferedAmount() {
      return 0;
    },
    backpressureSupported: false,
  });
  await connection.message('message');
}

void endpoint.admin;
void Binding.binding;
void Binding.createUpgradeLifecycle;
Binding.closeWebSocket({ close() {} }, 1000, 'done');
// @ts-expect-error — endpoint construction is not part of the public binding seam
Binding.createNodeEndpoint;
