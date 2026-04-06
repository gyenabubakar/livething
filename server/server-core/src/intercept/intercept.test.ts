import { intercept } from '~/intercept/intercept.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const pre = intercept(async (ctx: { userId: string }, message) => {
  const _user: string = ctx.userId;
  const _event: string = message.event;
  void [_user, _event];
  return message;
});

const post = intercept(
  'send-message',
  async (ctx: { userId: string }, payload: { text: string }) => {
    const _user: string = ctx.userId;
    const _text: string = payload.text;
    void [_user, _text];
    return payload;
  },
);

const _preType: PreInterceptPrimitive = pre;
const _postType: PostInterceptPrimitive<'send-message', { text: string }, { userId: string }> =
  post;
void [_preType, _postType];

const _preTag: 'intercept' = pre.__wskit;
const _postTag: 'intercept' = post.__wskit;
const _kind: PrimitiveKind = pre.__kind;
void [_preTag, _postTag, _kind];

const _ref: PrimitiveRef = intercept;
const _key: symbol = intercept.__key;
void [_ref, _key];
