<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	let insertResult = $state('');
	let lastInsertedId = $state(0);
	let recordList = $state('');
	let singleRecord = $state('');
	let recordCount = $state('');
	let deleteResult = $state('');
	let dbConnected = $state(false);
	let drizzleReadyPayload = $state('');
	let messageLog = $state<string[]>([]);
	let messageCountResult = $state('');
	let vacuumResult = $state('');
	let outgoingCountResult = $state('');
	let disconnectCountResult = $state('');
	let generatedIdResult = $state('');
	let lastStateResult = $state('');
	let shutdownCountResult = $state('');
	let rewriteResult = $state('');
	let everyTickCount = $state(0);
	let flakyResult = $state('');
	let dlqResult = $state('');
	let errorLog = $state('');
	let pluginTaskDataResult = $state('');
	let streamConnIdChunks = $state<string[]>([]);
	let streamThrowChunks = $state(0);
	let streamThrowId = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/plugins?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		ws.onopen = () => {
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
			dbConnected = false;
		};
		ws.onerror = () => {
			status = 'disconnected';
			ws = null;
		};

		ws.onmessage = (event) => {
			if (event.data === 'pong') return;
			const msg = JSON.parse(event.data as string) as {
				event: string;
				payload: Record<string, unknown>;
				__wskit?: Record<string, unknown>;
			};
			const { event: evt, payload } = msg;
			messageLog = [...messageLog, `${evt}: ${JSON.stringify(payload)}`].slice(-50);

			switch (evt) {
			case '__e2e:drizzle::drizzle-ready':
				dbConnected = true;
				drizzleReadyPayload = JSON.stringify(payload);
				break;
			case 'record-inserted':
				lastInsertedId = payload.id as number;
				insertResult = `id: ${payload.id}`;
				break;
			case 'record-list':
				recordList = JSON.stringify(payload.records);
				break;
			case 'single-record':
				singleRecord = JSON.stringify(payload.record);
				break;
			case 'record-count':
				recordCount = `count: ${payload.count}`;
				break;
			case 'record-deleted':
				deleteResult = payload.success ? 'deleted' : 'failed';
				break;
			case 'message-count':
				messageCountResult = `messages: ${payload.count}`;
				break;
			case '__e2e:drizzle::drizzle-vacuum-done':
				vacuumResult = `vacuum:${payload.timestamp}`;
				break;
			case 'outgoing-count':
				outgoingCountResult = `outgoing: ${payload.count}`;
				break;
			case 'disconnect-count':
				disconnectCountResult = `disconnects: ${payload.count}`;
				break;
			case 'generated-id':
				generatedIdResult = payload.value ? `generated: ${payload.value}` : 'generated: none';
				break;
			case 'last-state':
				lastStateResult = JSON.stringify(payload.state);
				break;
			case 'shutdown-count':
				shutdownCountResult = `shutdowns: ${payload.count}`;
				break;
			case 'plugin-rewrite-result':
				rewriteResult = `text:${payload.text},rewritten:${payload.rewritten ?? false}`;
				break;
			case '__e2e:drizzle::plugin-every-tick':
				everyTickCount = Number(payload.count);
				break;
			case '__e2e:drizzle::plugin-flaky-result':
				flakyResult = `attempts:${payload.attempts}`;
				break;
			case '__e2e:drizzle::plugin-dlq-result':
				dlqResult = `${payload.taskId}:attempts=${payload.attempts}:${payload.error}`;
				break;
			case '__e2e:drizzle::error-result':
				errorLog = JSON.stringify(payload);
				break;
			case '__e2e:drizzle::plugin-task-data-result':
				pluginTaskDataResult = payload.result as string;
				break;
			case 'stream-connection-id':
				if (typeof payload.id === 'string') {
					streamConnIdChunks = [...streamConnIdChunks, payload.id];
				}
				break;
			case 'stream-throw-on-cancel':
				if (typeof payload.tick === 'number') {
					streamThrowChunks++;
				}
				break;
			case '__streamOk__':
				if (typeof msg.__wskit?.streamId === 'string') streamThrowId = msg.__wskit.streamId;
				break;
			}
		};
	}

	function disconnect() {
		ws?.close();
		ws = null;
		status = 'disconnected';
		dbConnected = false;
	}

	function send(event: string, payload: Record<string, unknown> = {}) {
		ws?.send(JSON.stringify({ event, payload }));
	}
</script>

<main>
	<h1>wskit plugins e2e</h1>

	<section>
		<h2>Connection</h2>
		<input data-testid="username-input" bind:value={username} placeholder="username" />
		<button data-testid="connect-btn" onclick={connect} disabled={status !== 'disconnected'}
			>Connect</button
		>
		<button data-testid="disconnect-btn" onclick={disconnect} disabled={status !== 'connected'}
			>Disconnect</button
		>
		<span data-testid="status">{status}</span>
		<span data-testid="db-connected">{dbConnected ? 'db-ready' : ''}</span>
		<div data-testid="drizzle-ready-payload">{drizzleReadyPayload}</div>
	</section>

	<section>
		<h2>CRUD Operations</h2>
		<button
			data-testid="insert-btn"
			onclick={() => send('insert-record', { name: 'test-item', value: 'hello' })}
			disabled={status !== 'connected'}>Insert Record</button
		>
		<button
			data-testid="get-all-btn"
			onclick={() => send('get-all-records', {})}
			disabled={status !== 'connected'}>Get All</button
		>
		<button
			data-testid="get-one-btn"
			onclick={() => send('get-record', { id: lastInsertedId })}
			disabled={status !== 'connected'}>Get Record</button
		>
		<button
			data-testid="delete-btn"
			onclick={() => send('delete-record', { id: lastInsertedId })}
			disabled={status !== 'connected'}>Delete Record</button
		>
		<button
			data-testid="count-btn"
			onclick={() => send('get-record-count', {})}
			disabled={status !== 'connected'}>Get Count</button
		>
		<button
			data-testid="msg-count-btn"
			onclick={() => send('get-message-count', {})}
			disabled={status !== 'connected'}>Get Message Count</button
		>
		<div data-testid="insert-result">{insertResult}</div>
		<div data-testid="record-list">{recordList}</div>
		<div data-testid="single-record">{singleRecord}</div>
		<div data-testid="record-count">{recordCount}</div>
		<div data-testid="delete-result">{deleteResult}</div>
		<div data-testid="message-count">{messageCountResult}</div>
	</section>

	<section>
		<h2>Plugin Extras</h2>
		<button
			data-testid="vacuum-btn"
			onclick={() => send('__e2e:drizzle::trigger-vacuum', {})}
			disabled={status !== 'connected'}>Trigger Vacuum</button
		>
		<button
			data-testid="outgoing-count-btn"
			onclick={() => send('get-outgoing-count', {})}
			disabled={status !== 'connected'}>Get Outgoing Count</button
		>
		<button
			data-testid="disconnect-count-btn"
			onclick={() => send('get-disconnect-count', {})}
			disabled={status !== 'connected'}>Get Disconnect Count</button
		>
		<button
			data-testid="generated-id-btn"
			onclick={() => send('get-generated-id', {})}
			disabled={status !== 'connected'}>Get Generated ID</button
		>
		<button
			data-testid="last-state-btn"
			onclick={() => send('get-last-state', {})}
			disabled={status !== 'connected'}>Get Last State</button
		>
		<button
			data-testid="shutdown-count-btn"
			onclick={() => send('get-shutdown-count', {})}
			disabled={status !== 'connected'}>Get Shutdown Count</button
		>
		<div data-testid="vacuum-result">{vacuumResult}</div>
		<div data-testid="outgoing-count">{outgoingCountResult}</div>
		<div data-testid="disconnect-count">{disconnectCountResult}</div>
		<div data-testid="generated-id-result">{generatedIdResult}</div>
		<div data-testid="last-state-result">{lastStateResult}</div>
		<div data-testid="shutdown-count">{shutdownCountResult}</div>
	</section>

	<section>
		<h2>Plugin onIncoming Rewrite</h2>
		<button
			data-testid="plugin-rewrite-btn"
			onclick={() => send('plugin-rewrite-probe', { text: 'hello' })}
			disabled={status !== 'connected'}>Send Rewrite Probe</button
		>
		<div data-testid="plugin-rewrite-result">{rewriteResult}</div>
	</section>

	<section>
		<h2>Plugin Scheduled (every / retry / DLQ)</h2>
		<button
			data-testid="trigger-plugin-every-btn"
			onclick={() => send('__e2e:drizzle::trigger-plugin-every', {})}
			disabled={status !== 'connected'}>Trigger Every Tick</button
		>
		<button
			data-testid="trigger-plugin-flaky-btn"
			onclick={() => send('__e2e:drizzle::trigger-plugin-flaky', {})}
			disabled={status !== 'connected'}>Trigger Flaky</button
		>
		<button
			data-testid="trigger-plugin-always-fail-btn"
			onclick={() => send('__e2e:drizzle::trigger-plugin-always-fail', {})}
			disabled={status !== 'connected'}>Trigger Always Fail</button
		>
		<button
			data-testid="trigger-plugin-query-dlq-btn"
			onclick={() => send('__e2e:drizzle::trigger-plugin-query-dlq', {})}
			disabled={status !== 'connected'}>Query Plugin DLQ</button
		>
		<div data-testid="plugin-every-count">{everyTickCount}</div>
		<div data-testid="plugin-flaky-result">{flakyResult}</div>
		<div data-testid="plugin-dlq-result">{dlqResult}</div>
	</section>

	<section>
		<h2>Plugin Error Handling</h2>
		<button
			data-testid="plugin-error-btn"
			onclick={() => send('__e2e:drizzle::trigger-plugin-error', {})}
			disabled={status !== 'connected'}>Trigger Plugin Error</button
		>
		<div data-testid="error-log">{errorLog}</div>
	</section>

	<section>
		<h2>Plugin Scheduled with Data Validation</h2>
		<button
			data-testid="trigger-plugin-task-with-data-btn"
			onclick={() => send('__e2e:drizzle::trigger-plugin-task-with-data', {})}
			disabled={status !== 'connected'}>Trigger Task with Data</button
		>
		<div data-testid="plugin-task-data-result">{pluginTaskDataResult}</div>
	</section>

	<section>
		<h2>Stream calling plugin hooks.getState()</h2>
		<button
			data-testid="stream-connection-id-btn"
			onclick={() => send('stream-connection-id', { count: 3 })}
			disabled={status !== 'connected'}>Start stream</button
		>
		<div data-testid="stream-connection-id-chunks">{streamConnIdChunks.join(',')}</div>
	</section>

	<section>
		<h2>Stream that throws from finally on cancel</h2>
		<button
			data-testid="stream-throw-on-cancel-btn"
			onclick={() => send('stream-throw-on-cancel')}
			disabled={status !== 'connected'}>Start throwing stream</button
		>
		<div data-testid="stream-throw-chunks">{streamThrowChunks}</div>
		<div data-testid="stream-throw-id">{streamThrowId}</div>
	</section>

	<section>
		<h2>Message Log</h2>
		<div data-testid="message-log">{messageLog.join('\n')}</div>
	</section>
</main>

<style>
	main {
		font-family: monospace;
		padding: 1rem;
		max-width: 800px;
	}
	section {
		margin: 1rem 0;
		padding: 0.5rem;
		border: 1px solid #ccc;
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
</style>
