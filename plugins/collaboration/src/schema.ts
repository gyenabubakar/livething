import { LiveThingConfigError } from '@livething/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';

const KIND = '~collab';

/** Text that several people type into together. Reads as a `string`. */
export interface TextField {
  readonly [KIND]: 'text';
}

/** Rich text that an editor such as ProseMirror changes. Reads as plain text, for previews. */
export interface RichTextField {
  readonly [KIND]: 'rich-text';
}

/** A list whose items people add, delete and move at the same time. */
export interface ListField<TItem extends Field = Field> {
  readonly [KIND]: 'list';
  readonly item: TItem;
}

/** A map from keys you choose, such as user IDs, to items. */
export interface RecordField<TItem extends Field = Field> {
  readonly [KIND]: 'record';
  readonly item: TItem;
}

/** Any Standard Schema (valibot, zod, arktype, ...): a value that changes as a whole. */
export type Leaf = StandardSchemaV1;

/** A plain object of fields. Each field merges on its own. */
export interface Shape {
  readonly [key: string]: Field;
}

/** One part of a doc. */
export type Field = TextField | RichTextField | ListField<any> | RecordField<any> | Leaf | Shape;

/** Text that several people type into together. */
export function text(): TextField {
  return { [KIND]: 'text' };
}

/** Rich text for an editor such as ProseMirror, Tiptap or Lexical. */
export function richText(): RichTextField {
  return { [KIND]: 'rich-text' };
}

/** A list of `item`. Adds, deletes and moves from different people all merge. */
export function list<const TItem extends Field>(item: TItem): ListField<TItem> {
  return { [KIND]: 'list', item };
}

/** A map from keys you choose to `item`. Each key merges on its own. */
export function record<const TItem extends Field>(item: TItem): RecordField<TItem> {
  return { [KIND]: 'record', item };
}

/** A doc type: its name, the shape of its content, and the shape of each member's awareness state. */
export interface DocDef<
  TName extends string = string,
  TShape extends Shape = Shape,
  TAwareness extends Leaf | undefined = Leaf | undefined,
> {
  readonly name: TName;
  readonly shape: TShape;
  readonly awareness: TAwareness;
}

/** The options of {@link doc}. */
export interface DocOptions<TAwareness extends Leaf | undefined> {
  /** The shape of each member's live state in this doc, such as the task they are looking at. */
  readonly awareness?: TAwareness;
}

const DOC_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_$][\w$]*$/;
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

/**
 * Describe a doc type once, in code the server and the client share. Every type the
 * plugin uses is read from it.
 *
 * @example
 * ```ts
 * export const taskBoard = doc('task-board', {
 *   title: text(),
 *   archived: v.optional(v.boolean(), false),
 *   tasks: list({ id: v.string(), title: text(), done: v.boolean() }),
 * })
 * ```
 */
export function doc<
  const TName extends string,
  const TShape extends Shape,
  TAwareness extends Leaf | undefined = undefined,
>(
  name: TName,
  shape: TShape & TopDefaults<TShape>,
  options?: DocOptions<TAwareness>,
): DocDef<TName, TShape, TAwareness> {
  if (typeof name !== 'string' || !DOC_NAME.test(name)) {
    throw new LiveThingConfigError(
      `doc name '${String(name)}' is not valid. Use 1 to 64 lowercase letters, digits and hyphens, starting with a letter, such as 'task-board'.`,
    );
  }

  const context = `doc('${name}')`;
  if (!isShape(shape) || Object.keys(shape).length === 0) {
    throw new LiveThingConfigError(`${context} has no fields. Give it at least one.`);
  }

  checkShape(shape, { context, path: '', top: true, seen: new Set([shape]) });

  const awareness = options?.awareness;
  if (awareness !== undefined && !isLeaf(awareness)) {
    throw new LiveThingConfigError(
      `${context}: the 'awareness' option must be a Standard Schema, such as v.object({ ... }).`,
    );
  }

  return { name, shape, awareness: awareness as TAwareness };
}

/** A Standard Schema. Some libraries' schemas are functions, such as arktype's. */
function isLeaf(field: unknown): field is Leaf {
  return (
    (typeof field === 'object' || typeof field === 'function') &&
    field !== null &&
    typeof (field as Partial<Leaf>)['~standard']?.validate === 'function'
  );
}

function isShape(field: unknown): field is Shape {
  return (
    typeof field === 'object' &&
    field !== null &&
    !Array.isArray(field) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(field)) &&
    !(KIND in field) &&
    !isLeaf(field)
  );
}

/**
 * Where a check is. `top` is true while the path from the doc's top goes only through
 * plain objects: a value there exists before anyone writes it, so its schema must give
 * a default.
 */
interface Where {
  readonly context: string;
  readonly path: string;
  readonly top: boolean;
  /** The shapes on the path here, to refuse a shape that contains itself. */
  readonly seen: ReadonlySet<object>;
}

function checkShape(shape: Shape, where: Where): void {
  for (const [key, field] of Object.entries(shape)) {
    if (!FIELD_NAME.test(key) || RESERVED_FIELD_NAMES.has(key)) {
      throw new LiveThingConfigError(
        `${where.context}: '${where.path}${key}' is not a valid field name. Use letters, digits, '_' and '$', starting with a letter, '_' or '$'.`,
      );
    }

    checkField(field, { ...where, path: `${where.path}${key}` });
  }
}

function checkField(field: unknown, where: Where): void {
  if (isLeaf(field)) {
    if (where.top) checkDefault(field, where);
    return;
  }

  if (typeof field === 'object' && field !== null && where.seen.has(field)) {
    throw new LiveThingConfigError(`${where.context}: '${where.path}' contains itself.`);
  }

  if (typeof field === 'object' && field !== null && KIND in field) {
    const kind = (field as { [KIND]: unknown })[KIND];
    if (kind === 'text' || kind === 'rich-text') return;

    if (kind === 'list' || kind === 'record') {
      const item = (field as ListField | RecordField).item;
      const path = `${where.path}${kind === 'list' ? '[]' : '{}'}`;
      checkField(item, { ...where, path, top: false, seen: new Set([...where.seen, field]) });
      return;
    }
  }

  if (isShape(field) && Object.keys(field).length > 0) {
    const seen = new Set([...where.seen, field]);
    checkShape(field, { ...where, path: `${where.path}.`, seen });
    return;
  }

  throw new LiveThingConfigError(
    `${where.context}: '${where.path}' is not a field. Use text(), richText(), list(...), record(...), a Standard Schema, or a plain object of fields.`,
  );
}

/**
 * A value at the top must take `undefined` and give its default at once. Other values
 * are not run here: their schemas may rightly throw on `undefined`, and a schema that
 * checks asynchronously is refused when a change is checked.
 */
function checkDefault(schema: Leaf, where: Where): void {
  const { context, path } = where;
  let result: ReturnType<Leaf['~standard']['validate']>;
  try {
    result = schema['~standard'].validate(undefined);
  } catch (error) {
    throw new LiveThingConfigError(
      `${context}: the schema of '${path}' threw when it made the default: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Some libraries, such as zod, turn a throw into a Promise too, so this says both.
  if (result instanceof Promise) {
    result.catch(() => {});
    throw new LiveThingConfigError(
      `${context}: '${path}' did not give its default at once: its schema checks asynchronously, or it throws when given undefined. A change is checked at once, so use a schema that checks synchronously.`,
    );
  }

  if (result.issues) {
    throw new LiveThingConfigError(
      `${context}: '${path}' needs a default, because a new doc starts empty. For example: v.optional(v.boolean(), false).`,
    );
  }
}

// ---- types read from the schema ----

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * A value changes as a whole, so nothing inside it can be written: you set the whole
 * value again. Arrays and tuples keep their shape, read-only. `D` counts the levels, so a
 * type that contains itself, such as a JSON value type, stops 8 levels down instead of
 * going on forever: below that, it is left as it is.
 */
type DeepReadonly<T, D extends readonly 0[] = []> = unknown extends T
  ? T
  : D['length'] extends 8
    ? T
    : T extends string | number | boolean | bigint | symbol | null | undefined
      ? T // also a branded string or number, which is a primitive with an object part
      : T extends (...args: never[]) => unknown
        ? T
        : T extends Uint8Array
          ? T
          : T extends readonly (infer E)[]
            ? number extends T['length']
              ? readonly DeepReadonly<E, [...D, 0]>[] // any array, branded or not, reads as a plain read-only array
              : { readonly [K in keyof T]: DeepReadonly<T[K], [...D, 0]> } // a tuple keeps its shape
            : T extends ReadonlyMap<infer K, infer V>
              ? ReadonlyMap<DeepReadonly<K, [...D, 0]>, DeepReadonly<V, [...D, 0]>>
              : T extends ReadonlySet<infer V>
                ? ReadonlySet<DeepReadonly<V, [...D, 0]>>
                : { readonly [K in keyof T]: DeepReadonly<T[K], [...D, 0]> };

/** What reads a field: the read-only, plain JSON copy in `state` and `select()`. */
export type Snapshot<F> = F extends TextField | RichTextField
  ? string
  : F extends ListField<infer I>
    ? readonly Snapshot<I>[]
    : F extends RecordField<infer I>
      ? { readonly [key: string]: Snapshot<I> }
      : F extends Leaf
        ? DeepReadonly<StandardSchemaV1.InferOutput<F>>
        : F extends Shape
          ? Simplify<{ readonly [K in keyof F]: Snapshot<F[K]> }>
          : never;

/** What writes a whole field: a new list item, a record value, or a value. */
export type Input<F> = F extends TextField | RichTextField
  ? string
  : F extends ListField<infer I>
    ? readonly Input<I>[]
    : F extends RecordField<infer I>
      ? { readonly [key: string]: Input<I> }
      : F extends Leaf
        ? StandardSchemaV1.InferInput<F>
        : F extends Shape
          ? Simplify<{ readonly [K in keyof F]: Input<F[K]> }>
          : never;

/** A list in a draft. */
export interface DraftList<I extends Field> extends Iterable<Draft<I>> {
  readonly length: number;
  at(index: number): Draft<I> | undefined;
  find(predicate: (item: Snapshot<I>) => boolean): Draft<I> | undefined;
  findIndex(predicate: (item: Snapshot<I>) => boolean): number;
  push(...items: Input<I>[]): void;
  insert(index: number, ...items: Input<I>[]): void;
  set(index: number, item: Input<I>): void;
  delete(index: number, count?: number): void;
  /** Moves the item itself. Nothing is copied, so edits others make to it at the same time stay. */
  move(from: number, to: number): void;
}

/** A record in a draft. */
export interface DraftRecord<I extends Field> {
  readonly size: number;
  get(key: string): Draft<I> | undefined;
  has(key: string): boolean;
  set(key: string, item: Input<I>): void;
  delete(key: string): void;
  keys(): IterableIterator<string>;
}

/** Fields you change through their own methods or an editor, not by assigning. */
type ContainerKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Leaf ? never : S[K] extends TextField ? never : K;
}[keyof S];

/** A plain object in a draft: values and text are assigned, the rest is changed in place. */
export type DraftShape<S extends Shape> = Simplify<
  { -readonly [K in Exclude<keyof S, ContainerKeys<S>>]: Draft<S[K]> } & {
    readonly [K in ContainerKeys<S>]: Draft<S[K]>;
  }
>;

/** What `change()` hands you: an object shaped like the doc that you can write to. */
export type Draft<F> = F extends TextField | RichTextField
  ? string
  : F extends ListField<infer I>
    ? DraftList<I>
    : F extends RecordField<infer I>
      ? DraftRecord<I>
      : F extends Leaf
        ? DeepReadonly<StandardSchemaV1.InferOutput<F>>
        : F extends Shape
          ? DraftShape<F>
          : never;

/** The end of a path to a Yjs container. */
export interface YRef<T> {
  readonly '~yjs': T;
}

/** The Yjs type behind a field. */
export type YTypeOf<F> = F extends TextField
  ? Y.Text
  : F extends RichTextField
    ? Y.XmlFragment
    : F extends ListField<any> | RecordField<any> | Shape
      ? Y.Map<unknown>
      : never;

/** The paths `yjs.at()` follows, each ending at a Yjs type. A plain value has none. */
export type PathOf<F> = F extends TextField | RichTextField
  ? YRef<YTypeOf<F>>
  : F extends ListField<infer I>
    ? { readonly [index: number]: PathOf<I> }
    : F extends RecordField<infer I>
      ? { readonly [key: string]: PathOf<I> }
      : F extends Leaf
        ? { readonly '~a plain value has no Yjs type': true }
        : F extends Shape
          ? { readonly [K in keyof F]: PathOf<F[K]> }
          : never;

/** The doc types of an app, by name. */
export type DocsByName<TDocs extends readonly DocDef[]> = {
  [D in TDocs[number] as D['name']]: D;
};

/**
 * Marks a value at the top of a doc whose schema gives no default. The property name
 * is the message, because TypeScript prints the name of a missing property.
 */
interface NeedsDefault {
  readonly 'a value at the top of a doc needs a default, such as v.optional(v.boolean(), false)': true;
}

/** Keeps each field as it is, except a value at the top with no default, which gets {@link NeedsDefault}. */
type TopDefaults<S> = {
  [K in keyof S]: S[K] extends TextField | RichTextField | ListField<any> | RecordField<any>
    ? S[K]
    : S[K] extends Leaf
      ? undefined extends StandardSchemaV1.InferInput<S[K]>
        ? S[K]
        : NeedsDefault
      : S[K] extends Shape
        ? TopDefaults<S[K]>
        : S[K];
};
