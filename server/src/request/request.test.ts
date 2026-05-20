/* oxlint-disable @typescript-eslint/no-explicit-any */
import { request } from '~/request/request.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/request.ts';

// ===========================================================================
// 1. Event name preserved as literal
// ===========================================================================

const getHistory = request('get-history', async () => {});
const _eventLiteral: 'get-history' = getHistory.event;
void _eventLiteral;

// @ts-expect-error — event is 'get-history', not 'get-users'
const _wrongEvent: 'get-users' = getHistory.event;
void _wrongEvent;

// ===========================================================================
// 2. Handler receives ctx.respond() typed to TResponse
// ===========================================================================

const withResponse = request<'get-balance', unknown, { balance: number; currency: string }>(
  'get-balance',
  async (ctx) => {
    ctx.respond({ balance: 100, currency: 'USD' });
  },
);

const _responseType: RequestPrimitive<
  'get-balance',
  unknown,
  { balance: number; currency: string }
> = withResponse;
void _responseType;

// ===========================================================================
// 3. Without validator — payload is unknown
// ===========================================================================

const noValidator = request('get-presence', async (_ctx, _payload) => {
  const _unknown: unknown = _payload;
  void _unknown;
});

const _noValType: RequestPrimitive<'get-presence', unknown, unknown> = noValidator;
void _noValType;

// ===========================================================================
// ===========================================================================
// 5. With StandardSchema — payload inferred from schema
// ===========================================================================

declare const limitSchema: StandardSchemaV1<unknown, { limit: number }>;

const withSchema = request(
  'get-history',
  async (_ctx, payload) => {
    const _limit: number = payload.limit;
    void _limit;
  },
  { validator: limitSchema },
);

const _schemaType: RequestPrimitive<'get-history', { limit: number }, unknown> = withSchema;
void _schemaType;

// ===========================================================================
// 6. Carried ctx type
// ===========================================================================

type RequestCtx = {
  log(message: string): void;
};

const withCtx = request<'ping', unknown, unknown, RequestCtx>('ping', async (ctx) => {
  ctx.log('pong');
});

const _ctxType: RequestPrimitive<'ping', unknown, unknown, RequestCtx> = withCtx;
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
