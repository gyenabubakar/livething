// Huddle's own app code that docs examples call without showing: UI updates and data lookups.
// Every helper has a real signature, so a wrong call in an example is a type error.
import type { ConnectionQuality } from '@livething/client';
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
