/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: localKey / ctx.provide / ctx.inject type surface.
 */

import type { ConnectionContext } from '~/context.ts';
import { localKey } from './local-key.ts';
import type { LocalKey } from './local-key.ts';

// ---------------------------------------------------------------------------
// localKey — basic type inference
// ---------------------------------------------------------------------------

const StringKey = localKey<string>('greeting');
const NumberKey = localKey<number>('count');
const ObjKey = localKey<{ id: number }>('user');
const NoNameKey = localKey<string>();

declare const _sk: LocalKey<string>;
void [StringKey, NumberKey, ObjKey, NoNameKey, _sk];

// name is an optional debug string; identity is a symbol
const _name: string | undefined = StringKey.name;
const _id: symbol = StringKey.id;
void [_name, _id];

// ---------------------------------------------------------------------------
// ctx.provide — accepts the correct type
// ---------------------------------------------------------------------------

declare const ctx: ConnectionContext;

ctx.provide(StringKey, 'hello');
ctx.provide(NumberKey, 42);
ctx.provide(ObjKey, { id: 1 });

// @ts-expect-error — wrong value type for string key
ctx.provide(StringKey, 123);

// @ts-expect-error — wrong value type for number key
ctx.provide(NumberKey, 'oops');

// @ts-expect-error — wrong value type for object key
ctx.provide(ObjKey, 'not-an-object');

// ---------------------------------------------------------------------------
// ctx.inject — returns T | undefined
// ---------------------------------------------------------------------------

const _str: string | undefined = ctx.inject(StringKey);
const _num: number | undefined = ctx.inject(NumberKey);
const _obj: { id: number } | undefined = ctx.inject(ObjKey);
void [_str, _num, _obj];

// @ts-expect-error — cannot assign T | undefined to T (missing | undefined)
const _strStrict: string = ctx.inject(StringKey);
void _strStrict;

// ---------------------------------------------------------------------------
// LocalKey is not structurally compatible across different T
// ---------------------------------------------------------------------------

// @ts-expect-error — LocalKey<number> is not assignable to LocalKey<string>
const _wrongKey: LocalKey<string> = NumberKey;
void _wrongKey;
