import type { BinaryInput } from '@livething/core';
import type { Primitive, PrimitiveIdentity } from '~/primitives/types.ts';

/**
 * What an upload reads its bytes from. A `Blob`, a `Uint8Array` or an `ArrayBuffer` can
 * resume after a drop, since the client reads it again from the server's saved offset. An
 * `AsyncIterable` can be read only once, so it cannot resume.
 */
export type UploadSource = Blob | BinaryInput | AsyncIterable<Uint8Array>;

/** Options for one `binary.upload(...)`. */
export interface UploadOptions {
  /**
   * The upload's id. Give the id of an earlier upload to resume it, for example after a page
   * reload. Default: a new id. It is in `upload.id`.
   */
  uploadId?: string;
}

/**
 * One upload. Nothing is sent until `start()`. `start()` again after a `Disconnected`
 * rejection resumes from the server's saved offset.
 */
export interface Upload<TInfo> {
  /** The upload's id. Keep it to resume the upload later with `{ uploadId }`. */
  readonly id: string;
  /**
   * Send the upload, or resume it after a drop. Resolves with the reply's info when the
   * server's `run` returns. Rejects with `Disconnected` when the socket closes, with
   * `UploadAborted`, or with the error `run` threw. While it runs, a second call returns the
   * same promise. After it resolves, a call returns the same result.
   */
  start(): Promise<{ info: TInfo }>;
  /**
   * Stop the upload. The server stops `run`, runs `onDiscard` and forgets the upload. A
   * running `start()` rejects with `UploadAborted` (`'cancelled'`), and so does every later one.
   */
  cancel(): void;
  /**
   * Listen for progress: the bytes the server's `run` has read. After a resume it can go back
   * to the saved offset. Returns an unsubscribe.
   */
  onProgress(listener: (receivedBytes: number) => void): () => void;
}

/** The descriptor `uploads()` returns. `client()` adds `binary.upload` from the registered tags. */
export type UploadsPrimitive = Primitive & PrimitiveIdentity<'uploads', 'binary'>;
