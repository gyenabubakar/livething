/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
// Type-only checks for the primitives. tsc checks these; vitest never runs them.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { serialization } from '~/primitives/serialization/index.ts';
import type { WSKitError } from '@wskit/core';

interface C {
  incoming: { message: { text: string } };
}

// serialization: you must give binaryType and parseBinary together.
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

// onError accepts both forms: a protocol Event and a typed WSKitError.
const socket = client<C>()(connect('wss://example.com'));

socket.onError((error: Event) => {
  void error.type;
});

socket.onError((err: WSKitError) => {
  const _code: string = err.code;
  void _code;
});
