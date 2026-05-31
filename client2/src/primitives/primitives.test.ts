/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
/**
 * Type-level tests for Phase 2 primitives. Compiled by `tsc`, not run.
 */
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { serialization } from '~/primitives/serialization.ts';
import type { WSKitError } from '@wskit/core';

interface C {
  incoming: { message: { text: string } };
}

// ── serialization: binaryType and parseBinary are linked ──
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

// ── onError: both the protocol form and the application form type-check ──
const socket = client<C>()(connect('wss://example.com'));

socket.onError((error: Event) => {
  void error.type;
});

socket.onError((err: WSKitError) => {
  const _code: string = err.code;
  void _code;
});
