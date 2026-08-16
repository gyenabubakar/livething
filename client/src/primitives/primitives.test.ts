/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
// Type-only checks for the primitives. tsc checks these; vitest never runs them.
import { WSKitError } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { serialization } from '~/primitives/serialization/index.ts';

interface C {
  incoming: { message: { text: string } };
  errors: { 'room-full': { limit: number } };
}

serialization({
  binaryType: 'arraybuffer',
  parseBinary: (d: ArrayBuffer) => ({ event: 'x', payload: d.byteLength }),
});
serialization({ binaryType: 'blob', parseBinary: (d: Blob) => ({ event: 'x', payload: d.size }) });

// @ts-expect-error — binaryType without parseBinary
serialization({ binaryType: 'arraybuffer' });

// @ts-expect-error — parseBinary without binaryType
serialization({ parseBinary: () => null });

// @ts-expect-error — wrong data type for arraybuffer
serialization({
  binaryType: 'arraybuffer',
  parseBinary: (d: Blob) => ({ event: 'x', payload: d.size }),
});

const socket = client<C>()(connect('wss://example.com'));

socket.onError((error) => {
  // The transport-error case is a raw Event.
  if (error instanceof Event) {
    void error.type;
    return;
  }
  // A server the client's types don't match can still send an undeclared code.
  if (!(error instanceof WSKitError)) {
    return;
  }
  // Narrowed to the contract's errors: switching on the code types the detail.
  if (error.code === 'room-full') {
    const _limit: number = error.detail.limit;
    void _limit;
  }
});
