import { emits, server, t } from '@livething/server';
import { scheduled } from '@livething/server/scheduled';
import * as v from 'valibot';
import type { ConnectionContext, InferClient } from '@livething/server';

function assertNoConnectionAlarm(ctx: ConnectionContext) {
  // @ts-expect-error Product connection contexts cannot call the platform alarm API.
  ctx.setAlarm(Date.now());
}

const base = server({
  capabilities: [scheduled({ 'alarm-api-task': null }), emits({ 'alarm-api-reply': t<{}>() })],
  onInit(ctx) {
    // @ts-expect-error Product init handlers cannot call the platform alarm API.
    ctx.setAlarm(Date.now());
  },
  onShutdown(ctx) {
    // @ts-expect-error Product shutdown handlers cannot call the platform alarm API.
    ctx.setAlarm(Date.now());
  },
});

const alarmApiEvent = base.on('alarm-api-event', {
  input: v.object({}),
  run(ctx) {
    assertNoConnectionAlarm(ctx as unknown as ConnectionContext);
  },
});

const alarmApiTask = base.scheduled('alarm-api-task', {
  run(ctx) {
    // @ts-expect-error Product scheduled handlers cannot call the platform alarm API.
    ctx.setAlarm(Date.now());
  },
});

export const alarmApiDefinition = base.assemble({
  handlers: [alarmApiEvent, alarmApiTask],
  api: (ctx) => ({
    attemptPlatformAlarm() {
      // @ts-expect-error Product admin operations cannot call the platform alarm API.
      ctx.setAlarm(Date.now());
    },
  }),
});
export type AlarmApiClient = InferClient<typeof alarmApiDefinition>;
