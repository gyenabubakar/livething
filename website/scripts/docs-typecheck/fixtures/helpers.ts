// Huddle's own app code that docs examples call without showing: UI updates and data lookups.
// Every helper has a real signature, so a wrong call in an example is a type error.
import type { ConnectionQuality } from '@livething/client';
import type { UploadPiece } from '@livething/server/uploads';
import type { Message } from './base';

export declare function render(text: string): void;
export declare function appendMessage(message: Message): void;
export declare function saveMessageReport(
  messageId: string,
  reason: string,
  reportedBy: string,
): Promise<void>;
export declare function showToast(text: string): void;
export declare function loadProfile(
  userId: string,
): Promise<{ id: string; name: string; status: 'active' | 'away' | 'busy' }>;
export declare function searchMessages(query: string, signal?: AbortSignal): AsyncIterable<Message>;
export declare function loadMessages(roomId: string, before?: number): Promise<Message[]>;
export declare function newMessageId(): string;
export declare function addToRoster(memberId: string, meta: unknown): void;
export declare function removeFromRoster(memberId: string): void;
export declare function dimAvatar(memberId: string): void;
export declare function brightenAvatar(memberId: string): void;
export declare function userClickedStop(): boolean;
export declare function renderScoutReply(streamId: string, text: string): void;
export declare function showStreamError(error: unknown): void;
export declare function showAnnouncement(announcement: { text: string }): void;
export declare function backOffFor(ms: number): void;
export declare function logClientEvent(userId: string, text: string): void;
export declare function archiveRoom(roomId: string): Promise<void>;
export declare function unreadCount(userId: string): number;
export declare function loadRoom(roomId: string): Promise<{ id: string; name: string }>;
export declare function muteUser(userId: string, untilMs: number): void;
export declare function lookupProfile(
  userId: string,
): { id: string; name: string; status: 'active' | 'away' | 'busy' } | undefined;
export declare function loadMessagePreview(messageId: string): Promise<string>;
/** Checks that the bytes really are an image of that type, then stores them. */
export declare function saveAvatar(
  userId: string,
  fileType: 'image/png' | 'image/jpeg',
  bytes: Uint8Array,
): Promise<void>;
/** A small copy of the picture, for the preview the user sees right away. */
export declare function resizeAvatar(bytes: Uint8Array): Promise<Uint8Array>;
/** Shows the new avatar from its picture bytes. */
export declare function showAvatar(bytes: Uint8Array): void;
/** The last picture a member shared in a room, as the app stored it, or `undefined`. */
export declare function loadLastScreenPicture(
  roomId: string,
  from: string,
): Promise<{ id: string; bytes: Uint8Array } | undefined>;
/** Draws one picture of a member's shared screen in that member's window. */
export declare function paintScreen(from: string, bytes: Uint8Array): void;
/** The avatar picture the user picked, read from the file input. */
export declare const avatarBytes: Uint8Array;
/** One picture of this user's shared screen. */
export declare const pictureBytes: Uint8Array;
/** The pictures of this user's shared screen, one after another. */
export declare const screenPictures: readonly Uint8Array[];
/** A small PNG picture of an attachment's first page. */
export declare function makeThumbnail(
  attachmentId: string,
): Promise<{ fileType: 'image/png'; bytes: Uint8Array }>;
/** Opens a stored attachment, read from `fromByte` on in pieces of up to 256 KiB. */
export declare function openAttachment(
  attachmentId: string,
  fromByte: number,
): Promise<{
  name: string;
  type: string;
  pieces(signal: AbortSignal): AsyncIterable<Uint8Array>;
}>;
/** An uploaded attachment, as Huddle stores it. `roomId` is `null` until a message posts it. */
export interface StoredAttachment {
  attachmentId: string;
  ownerId: string;
  roomId: string | null;
  fileName: string;
  fileType: string;
  size: number;
}
/** Writes bytes into an attachment's file at `offset`. Writing the same bytes again is safe. */
export declare function writeAttachmentBytes(
  attachmentId: string,
  offset: number,
  bytes: Uint8Array,
): Promise<void>;
/** Saves the record of an attachment whose bytes are all stored. */
export declare function saveAttachment(attachment: StoredAttachment): Promise<void>;
/** The record of an attachment, or `undefined` when it does not exist. */
export declare function loadAttachment(attachmentId: string): Promise<StoredAttachment | undefined>;
/** Puts uploaded attachments in a room, so its members can download them. */
export declare function attachToRoom(attachmentIds: string[], roomId: string): Promise<void>;
/** Deletes an attachment's file and its record. Does nothing when it is already gone. */
export declare function deleteAttachment(attachmentId: string): Promise<void>;
/**
 * Joins an upload's pieces into parts of exactly `partBytes` bytes, and one shorter last part.
 * It copies the bytes, so each part is a new array that stays valid after the next piece.
 */
export declare function partsOf(
  pieces: AsyncIterable<UploadPiece>,
  partBytes: number,
): AsyncIterable<Uint8Array>;
/**
 * Puts each of an upload's pieces at its offset in one array of `totalBytes` bytes. Returns
 * `null` when the pieces have more or fewer bytes than `totalBytes`.
 */
export declare function collectBytes(
  pieces: AsyncIterable<UploadPiece>,
  totalBytes: number,
): Promise<Uint8Array | null>;
/** Returns a signed URL that lets anyone who has it read the attachment's file from the bucket, until it expires. */
export declare function signAttachmentUrl(
  attachmentId: string,
  expiresInSeconds: number,
): Promise<string>;
/** Starts a multipart upload of an attachment in Huddle's S3 or R2 bucket, and returns its id. */
export declare function startAttachmentUpload(attachmentId: string): Promise<string>;
/** Uploads one part of a multipart upload. Uploading the same part number again replaces it. */
export declare function uploadAttachmentPart(
  attachmentId: string,
  multipartId: string,
  partNumber: number,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ partNumber: number; etag: string }>;
/** Joins the uploaded parts into the attachment's file in the bucket. */
export declare function completeAttachmentUpload(
  attachmentId: string,
  multipartId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<void>;
/** Aborts a multipart upload, and deletes its parts. Does nothing when it is already gone. */
export declare function abortAttachmentUpload(
  attachmentId: string,
  multipartId: string,
): Promise<void>;
/** Writes bytes into a poll's picture at `offset`. Writing the same bytes again is safe. */
export declare function writePollImageBytes(
  pollId: string,
  offset: number,
  bytes: Uint8Array,
): Promise<void>;
/** The file the user picked to attach. */
export declare const pickedFile: File;
/** Shows how much of a file the server has read. */
export declare function showUploadProgress(
  fileName: string,
  receivedBytes: number,
  totalBytes: number,
): void;
/** Renders a room's messages as a PDF, in pieces of up to 256 KiB. */
export declare function renderRoomPdf(roomId: string): AsyncIterable<Uint8Array>;
/** The voice notes of a direct message in Huddle's older app, oldest first. */
export declare function loadOldVoiceNotes(
  dmName: string,
): Promise<{ id: string; from: string; durationMs: number; bytes: Uint8Array }[]>;
/** The voice note the user just recorded. */
export declare const voiceNoteBytes: Uint8Array;
/** Plays a voice note from a member of a direct message. */
export declare function playVoiceNote(from: string, bytes: Uint8Array): void;
/** Shows an attachment's thumbnail from its picture bytes. */
export declare function showThumbnail(fileType: 'image/png', bytes: Uint8Array): void;
/** Starts saving a downloaded attachment under its name. */
export declare function startFile(fileName: string, fileType: string): void;
/** Adds the next piece of the downloaded attachment to the file. */
export declare function appendToFile(bytes: Uint8Array): Promise<void>;
/** Takes a PNG picture of this user's shared screen, at most `maxWidth` pixels wide. */
export declare function capturePng(maxWidth: number): Promise<Uint8Array>;
export declare function deleteMessage(messageId: string): Promise<void>;
export declare function loadOnCallModeratorId(): Promise<string>;
export declare function runScoutStep(
  step: 'search' | 'read' | 'write',
  goal: string,
  options?: { context?: string; signal?: AbortSignal },
): Promise<string>;
export declare function roomExists(roomId: string): boolean;
export declare function buildDigest(userId: string): void;
export declare function sendDigestEmail(userId: string): boolean;
export declare function searchRoomMessages(roomId: string, query: string): AsyncIterable<Message>;
export declare function renderReceipt(
  userId: string,
  receipt: { received?: number; read?: number },
): void;
export declare function reloadChannelHistory(
  channelName: string,
  missedThrough: number,
): Promise<void>;
export declare function getSessionToken(): string;
export declare function containsProfanity(text: string): boolean;
export declare function maskProfanity(text: string): string;
export declare function isMuted(userId: string): boolean;
export declare function isBanned(userId: string): boolean;
export declare function saveMessages(messages: Message[]): void;
export declare function isUserBanned(userId: string): Promise<boolean>;
export declare function isRoomMember(userId: string, roomId: string): Promise<boolean>;
export declare function isSendingTooManyFrames(userId: string): boolean;
export declare function showMissingProfile(userId: string): void;
export declare function retryLoadingProfile(userId: string): void;
export declare function waitForReconnection(): void;
export declare function showOfflineNotice(): void;
export declare function askScoutAgain(): void;
export declare function showSlowDownToast(): void;
export declare function showRetryButton(): void;
export declare function showBannedScreen(reason: string): void;
export declare function refreshTokenAndReconnect(): void;
export declare function appendSearchHit(hit: Message): void;
export declare function appendScoutText(text: string): void;
export declare function markScoutReplyDone(): void;
export declare const errorTracker: { capture(error: unknown): void };

// Client chapters: connecting, primitives, channels.
export declare function getRegionalUrl(): string;
export declare function pickHealthyRegion(): Promise<string>;
export declare function getStoredToken(): string;
export declare function isExpired(token: string): boolean;
export declare function refreshToken(): Promise<string>;
export declare function refreshAuthToken(): void;
export declare function loadInviteToken(): string;
export declare function getFreshInviteToken(): string;
export declare function addAvatar(memberId: string, meta: Record<string, unknown>): void;
export declare function removeAvatar(memberId: string): void;
export declare function showOnlineDot(memberId: string): void;
export declare function hideOnlineDot(memberId: string): void;
export declare function renderRoster(
  members: readonly { meta: Record<string, unknown>; online: boolean }[],
): void;
export declare function showSpinner(): void;
export declare function hideSpinner(): void;
export declare function appendToRoom(channelName: string, message: Message): void;
export declare function openTab(channelName: string): void;
export declare function closeTab(channelName: string): void;
export declare function removeFromView(messageId: string): void;
export declare function showConfirmDialog(text: string): Promise<boolean>;
export declare function showMutedBanner(reason: string): Promise<void>;
export declare function showScoutError(error: unknown): void;
export declare function showScoutStalled(): void;
export declare function showDoubleGreyCheck(userId: string, receivedThrough: number): void;
export declare function showBlueCheck(userId: string, readThrough: number): void;
export declare function renderReceivedBy(userIds: string[]): void;
export declare function renderReadBy(userIds: string[]): void;
export declare function showBanner(text: string): void;
export declare function hideBanner(): void;
export declare function appendToken(text: string): void;
export declare function updateConnectionIndicator(
  quality: ConnectionQuality,
  latency: number | null,
): void;
export declare function setDotColor(color: string): void;
export declare function setTooltip(text: string): void;
export declare function showWeakConnectionBanner(): void;
export declare function doNotDisturbIsOn(): boolean;
export declare function reloadNotifications(missedThrough: number): Promise<void>;

// The Cloudflare Worker types that `wrangler types` generates, reduced to what the adapter docs call.
// An RPC call can be awaited, or chained without awaiting each level.
type HuddleAdmin = Awaited<
  ReturnType<InstanceType<typeof import('./servers').HuddleServer>['admin']>
>;
type HuddleAdminRpc = Promise<HuddleAdmin> & HuddleAdmin;
export interface HuddleDurableObjectStub {
  fetch(request: Request): Promise<Response>;
  shutdown(): Promise<void>;
  admin(): HuddleAdminRpc;
}
export declare function verifyClerkWebhook(request: {
  headers: unknown;
}): Promise<{ type: string; data: { id: string } }>;
export interface HuddleDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): HuddleDurableObjectStub;
}
export interface Env {
  HUDDLE_SERVER: HuddleDurableObjectNamespace;
  PRESENCE: HuddleDurableObjectNamespace;
  ROOM_TOPICS: { get(key: string): Promise<string | null> };
}
export interface ExportedHandler<TEnv> {
  fetch?(request: Request, env: TEnv): Response | Promise<Response>;
}
