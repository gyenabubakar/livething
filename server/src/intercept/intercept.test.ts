import { intercept } from '~/intercept/intercept.ts';
import type { InterceptPrimitive } from '~/intercept/intercept.ts';

const handler = intercept(async (ctx: { userId: string }, frame) => {
  const _user: string = ctx.userId;
  const _event: string = frame.event;
  const _kind: 'incoming' | 'request' | 'stream' | 'upload' | 'nudge' | 'unknown' = frame.kind;
  const _channel: string | undefined = frame.routing.channel;
  void [_user, _event, _kind, _channel];

  return frame.payload;
});

const _handlerType: InterceptPrimitive = handler;
void _handlerType;

const _tag: 'intercept' = handler.__livething;
void _tag;

const wrapped = intercept(async (ctx: { orgId: string }, frame) => {
  const _org: string = ctx.orgId;
  const _event: string = frame.event;
  void [_org, _event];
  return frame.payload;
});

const _wrappedType: InterceptPrimitive<{ orgId: string }> = wrapped;
void _wrappedType;
