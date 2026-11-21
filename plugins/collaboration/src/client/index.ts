export { collaboration } from '~/client/plugin.ts';
export { indexedDbStorage } from '~/client/indexeddb.ts';
export type { CollaborationClient, CollaborationClientOptions } from '~/client/plugin.ts';
export type {
  DocHandle,
  DocStatus,
  DocVersions,
  ReadOnlyDetail,
  Refusal,
  UpdateNotSentDetail,
} from '~/client/doc-handle.ts';
export type { DocAwareness, DocMember, LockHolder, TextCaret } from '~/client/awareness.ts';
export type { DocAnchors, DocHistory } from '~/client/doc-state.ts';
export type { TextInput } from '~/client/bind-text.ts';
export type { IndexedDbStorageOptions } from '~/client/indexeddb.ts';
export type { ReadableStore } from '~/client/store.ts';
