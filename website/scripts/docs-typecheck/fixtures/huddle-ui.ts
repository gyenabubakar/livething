import type { ConnectionQuality } from '@livething/client';
import type { JSX, ReactNode } from './modules/react';

export * from './helpers';

// Huddle's small UI components, as props that every framework's version of them shares.
export interface BarsProps {
  tier: ConnectionQuality;
  title: string;
}
export type CheckProps = { state: 'sent' | 'received' | 'read' };
export type ProfileCardProps = { id: string; name: string; status: 'active' | 'away' | 'busy' };
export type ErrorNoticeProps = { err: unknown };

export declare function Bars(props: BarsProps): JSX.Element;
export declare function Check(props: CheckProps): JSX.Element;
export declare function ProfileCard(props: ProfileCardProps): JSX.Element;
export declare function Spinner(): JSX.Element;

// The room's "who is reading" bar: one person per entry, with the messages their tabs show.
export declare function renderViewers(
  people: { name: string; messageIds: (string | null)[] }[],
): void;
// Calls back with the ID of the message at the top of the room's view, as the user scrolls.
export declare function onTopMessageChange(
  callback: (messageId: string | null) => void,
): () => void;
export declare function Banner(props: { children?: ReactNode }): JSX.Element;
export declare function Toast(props: { children?: ReactNode }): JSX.Element;
