/* oxlint-disable @typescript-eslint/no-explicit-any */
import { incoming } from '~/primitives/incoming.ts';
import { namespace } from '~/primitives/namespace.ts';
import { outgoing } from '~/primitives/outgoing.ts';
import { replay } from '~/primitives/replay.ts';
import { request } from '~/primitives/request.ts';
import { chunks, generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type { NamespacePrimitive } from '~/primitives/namespace.ts';

// ===========================================================================
// 1. namespace() preserves a string literal pattern
// ===========================================================================

const notifications = namespace(
  'notifications',
  outgoing('alert', t<{ id: string }>()),
  incoming(
    'dismiss',
    async (ctx, payload) => {
      const _name: string = ctx.namespaceName;
      const _id: string = payload.id;
      void [_name, _id];

      ctx.send('alert', { id: payload.id });

      // @ts-expect-error — namespace ctx only sees namespace outgoing events
      ctx.send('message', { text: payload.id });

      // @ts-expect-error — ack is not available in namespace scope
      ctx.ack();
    },
    { validator: (value: unknown) => value as { id: string } },
  ),
);

const _literalPattern: 'notifications' = notifications.pattern;
const _tag: 'namespace' = notifications.__wskit;
const _kind: PrimitiveKind = notifications.__kind;
const _namespaceType: NamespacePrimitive<'notifications'> = notifications;
void [_literalPattern, _tag, _kind, _namespaceType];

// ===========================================================================
// 2. namespace() types request() and generate() with namespace-local ctx
// ===========================================================================

const aiStream = stream(
  start('ask-ai', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const reports = namespace(
  'reports',
  outgoing('chunk', t<{ text: string }>()),
  outgoing('done', t<{ ok: true }>()),
  incoming('ping', async () => {}),
  request('status', async (ctx) => {
    const _name: string = ctx.namespaceName;
    void _name;

    ctx.send('done', { ok: true });

    return { ok: true };
  }),
  generate(aiStream, async function* (ctx, payload) {
    const _name: string = ctx.namespaceName;
    void _name;

    ctx.send('chunk', { text: payload.prompt });

    const nudges = ctx.nudges(yield { text: payload.prompt });
    const _event: 'cancel' = nudges[0]!.event;
    void _event;

    // @ts-expect-error — namespace stream ctx only sees namespace outgoing events
    ctx.send('message', { text: payload.prompt });

    // @ts-expect-error — namespace stream ctx has no ack
    ctx.ack();
  }),
);

const _reportsType: NamespacePrimitive<'reports'> = reports;
void _reportsType;

// ===========================================================================
// 3. namespace() does not accept replay()
// ===========================================================================

namespace(
  'no-replay',
  outgoing('alert', t<{ id: string }>()),
  // @ts-expect-error — replay is not allowed in namespace scope
  replay(),
);

// ===========================================================================
// 4. namespace is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = namespace;
const _key: symbol = namespace.__key;
void [_ref, _key];
