import * as encoding from 'lib0/encoding';

/** One string item for `rawUpdate`: after `origin`, or at the start of root `parent`. */
interface RawItem {
  readonly text: string;
  readonly origin?: { client: number; clock: number };
  readonly parent?: string;
}

/**
 * A Yjs update written by hand, as a bad client could send it: each client's string items in
 * clock order from 0, and no deletes. The Yjs API cannot make the broken ones tests need.
 */
function rawUpdate(clients: ReadonlyMap<number, readonly RawItem[]>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clients.size);
  for (const [client, items] of clients) {
    encoding.writeVarUint(encoder, items.length);
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, 0);
    for (const item of items) {
      // Content kind 4 is a string; bit 0x80 says an origin follows.
      encoding.writeUint8(encoder, 4 | (item.origin ? 0x80 : 0));
      if (item.origin) {
        encoding.writeVarUint(encoder, item.origin.client);
        encoding.writeVarUint(encoder, item.origin.clock);
      } else {
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarString(encoder, item.parent!);
      }

      encoding.writeVarString(encoder, item.text);
    }
  }

  encoding.writeVarUint(encoder, 0);

  return encoding.toUint8Array(encoder);
}

/** An update whose second item points forward, at the third: Yjs throws after the first. */
export function forwardUpdate(client: number, firstRoot: string): Uint8Array {
  return rawUpdate(
    new Map([
      [
        client,
        [
          { text: 'P', parent: firstRoot },
          { text: 'Q', origin: { client, clock: 2 } },
          { text: 'R', parent: 'title' },
        ],
      ],
    ]),
  );
}

/** Items of two clients that point at each other: Yjs holds them back forever. */
export function cycleUpdate(): Uint8Array {
  return rawUpdate(
    new Map([
      [777, [{ text: 'A', origin: { client: 888, clock: 0 } }]],
      [888, [{ text: 'B', origin: { client: 777, clock: 0 } }]],
    ]),
  );
}
