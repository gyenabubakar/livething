// Solid is not installed in this repo, so this holds its real signatures for what the docs use.
// Also resolves `solid-js/jsx-runtime`, which is where the Solid page's TSX gets its JSX types.
export type Accessor<T> = () => T;
export type Setter<in out T> = {
  <U extends T>(
    ...args: undefined extends T ? [] : [value: Exclude<U, Function> | ((prev: T) => U)]
  ): undefined extends T ? undefined : U;
  <U extends T>(value: (prev: T) => U): U;
  <U extends T>(value: Exclude<U, Function>): U;
  <U extends T>(value: Exclude<U, Function> | ((prev: T) => U)): U;
};
export type Component<P = {}> = (props: P) => JSX.Element;
export type Resource<T> = Accessor<T | undefined> & { loading: boolean; error: any };

export declare function createSignal<T>(): [Accessor<T | undefined>, Setter<T | undefined>];
export declare function createSignal<T>(value: T): [Accessor<T>, Setter<T>];
export declare function createMemo<T>(fn: () => T): Accessor<T>;
export declare function createResource<T, S>(
  source: S | false | null | (() => S | false | null),
  fetcher: (source: S) => T | Promise<T>,
): [Resource<T>, { refetch(): void }];
export declare function from<T>(
  producer:
    | ((setter: Setter<T | undefined>) => () => void)
    | { subscribe(fn: (value: T | undefined) => void): (() => void) | { unsubscribe(): void } },
): Accessor<T | undefined>;
export declare function onMount(fn: () => void): void;
export declare function onCleanup<T extends () => unknown>(fn: T): T;

export declare function Show<T>(props: {
  when: T | undefined | null | false;
  fallback?: JSX.Element;
  children: JSX.Element | ((item: Accessor<NonNullable<T>>) => JSX.Element);
}): JSX.Element;
export declare function For<T extends readonly unknown[], U extends JSX.Element>(props: {
  each: T | undefined | null | false;
  fallback?: JSX.Element;
  children: (item: T[number], index: Accessor<number>) => U;
}): JSX.Element;

interface HtmlProps {
  children?: JSX.Element;
  class?: string;
  title?: string;
}

export namespace JSX {
  export type Element = Node | ArrayElement | (string & {}) | number | boolean | null | undefined;
  export interface ArrayElement extends Array<Element> {}
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicElements {
    div: HtmlProps;
    li: HtmlProps & { onClick?: () => void };
    span: HtmlProps;
    ul: HtmlProps;
  }
}
