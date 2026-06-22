/* oxlint-disable @typescript-eslint/no-explicit-any */
import { request } from '~/request/request.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/request.ts';

const getHistory = request('get-history', async (ctx) => {
  ctx.respond(undefined);
});
const _eventLiteral: 'get-history' = getHistory.event;
void _eventLiteral;

// @ts-expect-error — event is 'get-history', not 'get-users'
const _wrongEvent: 'get-users' = getHistory.event;
void _wrongEvent;

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

const noValidator = request('get-presence', async (ctx, _payload) => {
  const _unknown: unknown = _payload;
  void _unknown;
  ctx.respond(undefined);
});

const _noValType: RequestPrimitive<'get-presence', unknown, unknown> = noValidator;
void _noValType;

declare const limitSchema: StandardSchemaV1<unknown, { limit: number }>;

const withSchema = request(
  'get-history',
  async (ctx, payload) => {
    const _limit: number = payload.limit;
    void _limit;
    ctx.respond(undefined);
  },
  { validator: limitSchema },
);

const _schemaType: RequestPrimitive<'get-history', { limit: number }, unknown> = withSchema;
void _schemaType;

type RequestCtx = {
  log(message: string): void;
};

const withCtx = request<'ping', unknown, unknown, RequestCtx>('ping', async (ctx) => {
  ctx.log('pong');
  ctx.respond(undefined);
});

const _ctxType: RequestPrimitive<'ping', unknown, unknown, RequestCtx> = withCtx;
void _ctxType;

const _tag: 'request' = getHistory.__wskit;
const _kind: PrimitiveKind = getHistory.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = request;
const _key: symbol = request.__key;
void [_ref, _key];
