<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let connectionId = $state('');
	let targetId = $state('');

	let cleanupFired = $state(false);
	let cleanupCancelled = $state(false);
	let heartbeatCount = $state(0);
	let flakyAttempts = $state<number | null>(null);
	let defaultRetryAttempts = $state<number | null>(null);
	let deadLetter = $state('');
	let filteredLabels = $state<string[]>([]);
	let cancelNothingOk = $state(false);
	let scheduleGuardError = $state('');
	let sendToConnDelivery = $state('');
	let sendToConnStatus = $state('');
	let broadcastResult = $state('');
	let sendToTagResult = $state('');
	let cancelNonexistentOk = $state(false);
	let scheduleUnknownTaskResult = $state('');

	const eventHandlers: Record<string, (payload: Record<string, any>) => void> = {
		'cleanup-done': () => (cleanupFired = true),
		'cleanup-cancelled': () => (cleanupCancelled = true),
		'heartbeat-tick': () => (heartbeatCount += 1),
		'flaky-task-result': (payload) => (flakyAttempts = payload.attempts ?? null),
		'default-retry-result': (payload) => (defaultRetryAttempts = payload.attempts ?? null),
		'dead-letter-result': (payload) =>
			(deadLetter = `${payload.taskId}:attempts=${payload.attempts}:${payload.error}`),
		'filtered-task-result': (payload) => (filteredLabels = [...filteredLabels, payload.label ?? '']),
		'cancel-nothing-ok': () => (cancelNothingOk = true),
		'schedule-guard-error': (payload) => (scheduleGuardError = payload.message ?? ''),
		'schedule-send-to-conn-delivery': (payload) => (sendToConnDelivery = payload.text ?? ''),
		'schedule-send-to-conn-status': (payload) =>
			(sendToConnStatus = `id:${payload.connectionId},delivered:${payload.delivered}`),
		'who-am-i-result': (payload) => (connectionId = payload.connectionId ?? ''),
		'broadcast-result': (payload) => (broadcastResult = payload.text ?? ''),
		'send-to-tag-result': (payload) => (sendToTagResult = payload.text ?? ''),
		'cancel-nonexistent-ok': () => (cancelNonexistentOk = true),
		'schedule-unknown-task-result': (payload) =>
			(scheduleUnknownTaskResult = `${payload.rejected ? 'rejected' : 'accepted'}:${payload.message ?? ''}`),
	};

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/scheduled?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;

			const data = JSON.parse(ev.data);
			eventHandlers[data.event]?.(data.payload ?? {});
		};
	}

	function send(event: string, payload: Record<string, unknown> = {}) {
		ws?.send(JSON.stringify({ event, payload }));
	}
</script>

<h1>scheduled feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="who-am-i" onclick={() => send('who-am-i')}>Who am I</button>
<button data-testid="schedule-cleanup-soon" onclick={() => send('schedule-cleanup', { delayMs: 200 })}>
	Schedule cleanup soon
</button>
<button data-testid="schedule-cleanup-long" onclick={() => send('schedule-cleanup', { delayMs: 10_000 })}>
	Schedule cleanup long
</button>
<button data-testid="cancel-cleanup" onclick={() => send('cancel-cleanup')}>Cancel cleanup</button>
<button data-testid="start-heartbeat" onclick={() => send('start-heartbeat')}>Start heartbeat</button>
<button data-testid="trigger-flaky" onclick={() => send('trigger-flaky-task')}>Trigger flaky</button>
<button data-testid="trigger-default-retry" onclick={() => send('trigger-default-retry-task')}>
	Trigger default retry
</button>
<button data-testid="trigger-always-fail" onclick={() => send('trigger-always-fail')}>
	Trigger always-fail
</button>
<button data-testid="trigger-bigint-throw" onclick={() => send('trigger-bigint-throw')}>
	Trigger bigint-throw
</button>
<button data-testid="query-dlq" onclick={() => send('query-dead-letter')}>Query DLQ</button>
<button data-testid="schedule-filtered" onclick={() => send('schedule-filtered-tasks')}>
	Schedule filtered (drop+keep)
</button>
<button data-testid="cancel-drop" onclick={() => send('cancel-filtered-task', { label: 'drop' })}>
	Cancel drop
</button>
<button data-testid="cancel-nothing" onclick={() => send('cancel-nothing')}>Cancel nothing</button>
<button data-testid="trigger-invalid-cleanup-data" onclick={() => send('trigger-invalid-cleanup-data')}>
	Trigger invalid cleanup data
</button>
<button data-testid="trigger-invalid-schedule-time" onclick={() => send('trigger-invalid-schedule-time')}>
	Trigger invalid schedule time
</button>
<button data-testid="trigger-empty-backoff" onclick={() => send('trigger-empty-backoff')}>
	Trigger empty backoff
</button>
<button data-testid="schedule-broadcast-task" onclick={() => send('schedule-broadcast-task')}>
	Schedule broadcast task
</button>
<button data-testid="schedule-send-to-tag" onclick={() => send('schedule-send-to-tag')}>
	Schedule send-to-tag
</button>
<button data-testid="cancel-nonexistent-task" onclick={() => send('cancel-nonexistent')}>
	Cancel nonexistent
</button>
<button
	data-testid="schedule-unknown-task"
	onclick={() => send('trigger-schedule-unknown-task')}
>
	Schedule unknown task
</button>
<button data-testid="tag-vip" onclick={() => send('tag-vip')}>Tag vip</button>

<input data-testid="target-id" bind:value={targetId} placeholder="target connection id" />
<button
	data-testid="schedule-send-to-self"
	onclick={() => send('schedule-send-to-conn', { connectionId, text: 'from-task' })}
>
	Schedule send-to-conn (self)
</button>
<button
	data-testid="schedule-send-to-stale"
	onclick={() =>
		send('schedule-send-to-conn', {
			connectionId: 'stale-id-does-not-exist',
			text: 'from-task',
		})}
>
	Schedule send-to-conn (stale)
</button>
<button
	data-testid="schedule-send-to-target"
	onclick={() => send('schedule-send-to-conn', { connectionId: targetId, text: 'from-task' })}
>
	Schedule send-to-conn (target)
</button>

<span data-testid="status">{status}</span>
<span data-testid="connection-id">{connectionId}</span>
<span data-testid="cleanup-fired">{cleanupFired ? 'yes' : 'no'}</span>
<span data-testid="cleanup-cancelled">{cleanupCancelled ? 'yes' : 'no'}</span>
<span data-testid="heartbeat-count">{heartbeatCount}</span>
<span data-testid="flaky-attempts">{flakyAttempts ?? ''}</span>
<span data-testid="default-retry-attempts">{defaultRetryAttempts ?? ''}</span>
<span data-testid="dead-letter">{deadLetter}</span>
<span data-testid="filtered-labels">{filteredLabels.join(',')}</span>
<span data-testid="cancel-nothing-ok">{cancelNothingOk ? 'yes' : 'no'}</span>
<span data-testid="schedule-guard-error">{scheduleGuardError}</span>
<span data-testid="send-to-conn-delivery">{sendToConnDelivery}</span>
<span data-testid="send-to-conn-status">{sendToConnStatus}</span>
<span data-testid="broadcast-result">{broadcastResult}</span>
<span data-testid="send-to-tag-result">{sendToTagResult}</span>
<span data-testid="cancel-nonexistent-ok">{cancelNonexistentOk ? 'yes' : 'no'}</span>
<span data-testid="schedule-unknown-task-result">{scheduleUnknownTaskResult}</span>
