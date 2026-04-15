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
	let messageLog = $state<string[]>([]);
	let messageCountResult = $state('');
	let vacuumResult = $state('');
	let outgoingCountResult = $state('');
	let disconnectCountResult = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/modules?username=${encodeURIComponent(username)}`,
		);

		ws.onopen = () => {
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
			};
			const { event: evt, payload } = msg;
			messageLog = [...messageLog, `${evt}: ${JSON.stringify(payload)}`].slice(-50);

			switch (evt) {
				case '__e2e:drizzle:drizzle-ready':
					dbConnected = true;
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
				case 'drizzle-vacuum-done':
					vacuumResult = `vacuum:${payload.timestamp}`;
					break;
				case 'outgoing-count':
					outgoingCountResult = `outgoing: ${payload.count}`;
					break;
				case 'disconnect-count':
					disconnectCountResult = `disconnects: ${payload.count}`;
					break;
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function send(event: string, payload: Record<string, unknown> = {}) {
		ws?.send(JSON.stringify({ event, payload }));
	}
</script>

<main>
	<h1>wskit modules e2e</h1>

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
		<h2>Module Extras</h2>
		<button
			data-testid="vacuum-btn"
			onclick={() => send('trigger-vacuum', {})}
			disabled={status !== 'connected'}>Trigger Vacuum</button
		>
		<button
			data-testid="outgoing-count-btn"
			onclick={() => send('get-outgoing-count', {})}
			disabled={status !== 'connected'}>Get Outgoing Count</button
		>
		<button data-testid="disconnect-count-btn" onclick={() => send('get-disconnect-count', {})} disabled={status !== 'connected'}>Get Disconnect Count</button>
		<div data-testid="vacuum-result">{vacuumResult}</div>
		<div data-testid="outgoing-count">{outgoingCountResult}</div>
		<div data-testid="disconnect-count">{disconnectCountResult}</div>
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
