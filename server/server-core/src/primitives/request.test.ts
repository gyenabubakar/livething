/* oxlint-disable @typescript-eslint/no-explicit-any */

import { request } from '~/primitives/request.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';

// ===========================================================================
// 1. Event name preserved as literal
// ===========================================================================

const getHistory = request('get-history', async () => ({ messages: [] }));
const _eventLiteral: 'get-history' = getHistory.event;
void _eventLiteral;

// @ts-expect-error — event is 'get-history', not 'get-users'
const _wrongEvent: 'get-users' = getHistory.event;
void _wrongEvent;

// ===========================================================================
// 2. Response type inferred from handler return
// ===========================================================================

const withResponse = request('get-balance', async (_ctx) => {
  return { balance: 100, currency: 'USD' };
});

const _responseType: RequestPrimitive<
  'get-balance',
  unknown,
  { balance: number; currency: string }
> = withResponse;
void _responseType;

// ===========================================================================
// 3. Without validator — payload is unknown, response inferred
// ===========================================================================

const noValidator = request('get-presence', async (_ctx, _payload) => {
  const _unknown: unknown = _payload;
  void _unknown;
  return { users: ['alice'] };
});

const _noValType: RequestPrimitive<'get-presence', unknown, { users: string[] }> = noValidator;
void _noValType;

// ===========================================================================
// 4. With parse function — payload and response both inferred
// ===========================================================================

const withParse = request(
  'get-history',
  async (_ctx, payload) => {
    const _limit: number = payload.limit;
    void _limit;
    return { messages: [], hasMore: false };
  },
  {
    validator: (p: unknown) => {
      const obj = p as Record<string, unknown>;
      if (typeof obj.limit !== 'number') throw new Error('limit required');
      return { limit: obj.limit };
    },
  },
);

const _parseType: RequestPrimitive<
  'get-history',
  { limit: number },
  { messages: never[]; hasMore: boolean }
> = withParse;
void _parseType;

// ===========================================================================
// 5. With StandardSchema — payload inferred from schema, response from return
// ===========================================================================

declare const limitSchema: StandardSchemaV1<unknown, { limit: number }>;

const withSchema = request(
  'get-history',
  async (_ctx, payload) => {
    const _limit: number = payload.limit;
    void _limit;
    return { messages: ['hi'], total: 1 };
  },
  { validator: limitSchema },
);

const _schemaType: RequestPrimitive<
  'get-history',
  { limit: number },
  { messages: string[]; total: number }
> = withSchema;
void _schemaType;

// ===========================================================================
// 6. Carried ctx type
// ===========================================================================

type RequestCtx = {
  log(message: string): void;
};

const withCtx = request('ping', async (ctx: RequestCtx) => {
  ctx.log('pong');
  return { ok: true };
});

const _ctxType: RequestPrimitive<'ping', unknown, { ok: boolean }, RequestCtx> = withCtx;
void _ctxType;

// ===========================================================================
// 7. Primitive base fields
// ===========================================================================

const _tag: 'request' = getHistory.__wskit;
const _kind: PrimitiveKind = getHistory.__kind;
void [_tag, _kind];

// ===========================================================================
// 8. request is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = request;
const _key: symbol = request.__key;
void [_ref, _key];
