// The same code as `server/attachment-files.ts` on the uploads page, which Huddle's upload
// handlers import.
import type { UploadDiscardHandle, UploadPiece, UploadRunHandle } from '@livething/server/uploads';
import { deleteAttachment, isRoomMember, loadAttachment, writeAttachmentBytes } from './helpers';

/** The attachment an upload writes. A new upload gets a new ID, and a resumed one finds it in its state. */
export function attachmentIdOf(upload: UploadRunHandle): string {
  if (typeof upload.state === 'string') return upload.state;

  const attachmentId = crypto.randomUUID();
  upload.saved(upload.savedThrough, { state: attachmentId });

  return attachmentId;
}

/** Writes each piece into the attachment's file, and returns the size of the file. */
export async function writePieces(
  upload: UploadRunHandle,
  attachmentId: string,
  pieces: AsyncIterable<UploadPiece>,
): Promise<number> {
  let size = upload.savedThrough;

  for await (const { bytes, offset } of pieces) {
    await writeAttachmentBytes(attachmentId, offset, bytes);
    size = offset + bytes.byteLength;
    upload.saved(size);
  }

  return size;
}

/** Deletes the file of an upload that did not finish. Safe to run twice. */
export async function discardAttachment(upload: UploadDiscardHandle): Promise<void> {
  if (typeof upload.state === 'string') await deleteAttachment(upload.state);
}

/** The owner can read an attachment, and so can the members of the room it was posted in. */
export async function canReadAttachment(userId: string, attachmentId: string): Promise<boolean> {
  const attachment = await loadAttachment(attachmentId);
  if (!attachment) return false;

  if (attachment.ownerId === userId) return true;

  return attachment.roomId !== null && (await isRoomMember(userId, attachment.roomId));
}
