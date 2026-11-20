// React is not installed in this repo, so this holds its real signatures for what the docs use.
// Also resolves `react/jsx-runtime`, which is where TSX examples get their JSX types.
export type ReactNode =
  | JSX.Element
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Iterable<ReactNode>;

export type SetStateAction<S> = S | ((prevState: S) => S);
export type Dispatch<A> = (value: A) => void;
export type DependencyList = readonly unknown[];
export type EffectCallback = () => void | (() => void);

export declare function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
export declare function useState<S = undefined>(): [
  S | undefined,
  Dispatch<SetStateAction<S | undefined>>,
];
export declare function useEffect(effect: EffectCallback, deps?: DependencyList): void;
export interface RefObject<T> {
  current: T;
}
export declare function useRef<T>(initialValue: T): RefObject<T>;
export declare function useRef<T>(initialValue: T | null): RefObject<T | null>;
export declare function useMemo<T>(factory: () => T, deps: DependencyList): T;
export declare function memo<P>(component: (props: P) => ReactNode): (props: P) => ReactNode;
export declare function useSyncExternalStore<Snapshot>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot,
): Snapshot;

interface HtmlProps {
  key?: string | number;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export namespace JSX {
  export interface Element {
    type: unknown;
    props: unknown;
    key: string | null;
  }
  export type ElementType = keyof IntrinsicElements | ((props: any) => ReactNode);
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  export interface IntrinsicElements {
    button: HtmlProps & { onClick?: () => void };
    input: HtmlProps & { ref?: RefObject<HTMLInputElement | null>; readOnly?: boolean };
    div: HtmlProps;
    li: HtmlProps & { onClick?: () => void };
    span: HtmlProps;
    ul: HtmlProps;
  }
}
