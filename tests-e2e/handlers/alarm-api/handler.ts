import { define, emits, t } from '@wskit/server';
import { scheduled } from '@wskit/server/scheduled';
import * as v from 'valibot';
import type { ConnectionContext, InferClient } from '@wskit/server';

function assertNoConnectionAlarm(ctx: ConnectionContext) {
  // @ts-expect-error Product connection contexts cannot call the platform alarm API.
  ctx.setAlarm(Date.now());
}

const base = define({
  capabilities: [scheduled({ 'alarm-api-task': null }), emits({ 'alarm-api-reply': t<{}>() })],
});

base.onInit((ctx) => {
  // @ts-expect-error Product init handlers cannot call the platform alarm API.
  ctx.setAlarm(Date.now());
});

const alarmApiEvent = base.on('alarm-api-event', {
  input: v.object({}),
  run(ctx) {
    assertNoConnectionAlarm(ctx as unknown as ConnectionContext);
  },
});

base.onShutdown((ctx) => {
  // @ts-expect-error Product shutdown handlers cannot call the platform alarm API.
  ctx.setAlarm(Date.now());
});

base.scheduled('alarm-api-task', {
  run(ctx) {
    // @ts-expect-error Product scheduled handlers cannot call the platform alarm API.
    ctx.setAlarm(Date.now());
  },
});

export const alarmApiHandler = base.assemble({
  handlers: [alarmApiEvent],
  api: (ctx) => ({
    attemptPlatformAlarm() {
      // @ts-expect-error Product admin operations cannot call the platform alarm API.
      ctx.setAlarm(Date.now());
    },
  }),
});
export type AlarmApiClient = InferClient<typeof alarmApiHandler>;
