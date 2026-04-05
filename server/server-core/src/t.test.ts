/* oxlint-disable @typescript-eslint/no-explicit-any */

import { t } from '~/t.ts';
import type { TypeMarker } from '~/t.ts';

// ===========================================================================
// 1. t<T>() carries the generic type
// ===========================================================================

const marker = t<{ text: string; from: string }>();

// The phantom __type field carries the shape
type Carried = (typeof marker)['__type'];

const _check: Carried = { text: 'hello', from: 'alice' };
void _check;

// @ts-expect-error — wrong shape
const _wrong: Carried = { bad: true };
void _wrong;

// ===========================================================================
// 2. TypeMarker is covariant (out T)
// ===========================================================================

// A marker of a subtype is assignable to a marker of a supertype
type Narrow = TypeMarker<{ x: number; y: number }>;
type Wide = TypeMarker<{ x: number }>;

const _narrow: Narrow = t<{ x: number; y: number }>();
const _wide: Wide = _narrow;
void _wide;

// ===========================================================================
// 3. Different t() calls produce distinct types
// ===========================================================================

const stringMarker = t<string>();
const numberMarker = t<number>();

type StringType = (typeof stringMarker)['__type'];
type NumberType = (typeof numberMarker)['__type'];

const _s: StringType = 'hello';
const _n: NumberType = 42;
void [_s, _n];

// @ts-expect-error — string is not number
const _mismatch: NumberType = 'hello';
void _mismatch;

// ===========================================================================
// 4. Works with complex types
// ===========================================================================

interface ChatMessage {
  id: string;
  text: string;
  from: string;
  timestamp: number;
}

const chatMarker = t<ChatMessage>();
type ChatType = (typeof chatMarker)['__type'];

const _msg: ChatType = { id: '1', text: 'hi', from: 'alice', timestamp: Date.now() };
void _msg;

// @ts-expect-error — missing required field
const _incomplete: ChatType = { id: '1', text: 'hi' };
void _incomplete;
