import type { Component, Snippet } from 'svelte';
import type { BarsProps, CheckProps, ErrorNoticeProps, ProfileCardProps } from './huddle-ui';

export * from './helpers';

export declare const Bars: Component<BarsProps>;
export declare const Check: Component<CheckProps>;
export declare const ProfileCard: Component<ProfileCardProps>;
export declare const ErrorNotice: Component<ErrorNoticeProps>;
export declare const Spinner: Component;
export declare const Banner: Component<{ children?: Snippet }>;
export declare const Toast: Component<{ children?: Snippet }>;
