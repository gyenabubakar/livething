import type { BarsProps, CheckProps, ProfileCardProps } from './huddle-ui';
import type { JSX } from './modules/solid-js';

export * from './helpers';

export declare function Bars(props: BarsProps): JSX.Element;
export declare function Check(props: CheckProps): JSX.Element;
export declare function ProfileCard(props: ProfileCardProps): JSX.Element;
export declare function Spinner(): JSX.Element;
export declare function Banner(props: { children?: JSX.Element }): JSX.Element;
