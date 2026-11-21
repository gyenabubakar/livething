/** `[index, count]` of one part of an update, or `null` when the update fits one message. */
export type PartOf = readonly [index: number, count: number] | null;

/** Call `send` once per piece of `update`, in order: one piece, or parts of at most `size` bytes. */
export function eachPart(
  update: Uint8Array,
  size: number,
  send: (bytes: Uint8Array, part: PartOf) => void,
): void {
  // A message limit of 1 byte gives a size of 0: refuse it rather than loop forever.
  if (!(size >= 1)) throw new RangeError(`a part must be at least 1 byte, got ${size}`);

  const count = Math.ceil(update.length / size);
  if (count <= 1) {
    send(update, null);
    return;
  }

  for (let index = 0; index < count; index += 1) {
    send(update.subarray(index * size, (index + 1) * size), [index, count]);
  }
}

/** The pieces as one array of bytes. */
export function joinBytes(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;

  const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }

  return out;
}
