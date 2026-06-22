<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastStreamId = $state('');
	let streamOkReceived = $state(false);
	let chunkIndices = $state<number[]>([]);
	let signalFired = $state(false);
	let signalAborted = $state<'' | 'yes' | 'no'>('');
	let signalReason = $state('');
	let signalRanToCompletion = $state<'' | 'yes' | 'no'>('');

	function reset() {
		lastStreamId = '';
		streamOkReceived = false;
		chunkIndices = [];
		signalFired = false;
		signalAborted = '';
		signalReason = '';
		signalRanToCompletion = '';
	}

	function connect() {
		if (ws) return;
		status = 'connecting';
		reset();
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-signal?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			switch (data.event) {
				case '__streamOk__':
					streamOkReceived = true;
					if (data.__wskit?.streamId) lastStreamId = data.__wskit.streamId;
					break;
				case 'slow-signal':
					if (typeof data.payload?.index === 'number') {
						chunkIndices = [...chunkIndices, data.payload.index];
					}
					break;
				case 'signal-fired':
					signalFired = true;
					signalAborted = data.payload?.aborted ? 'yes' : 'no';
					signalReason = String(data.payload?.reason ?? '');
					signalRanToCompletion = data.payload?.ranToCompletion ? 'yes' : 'no';
					break;
			}
		};
	}

	function startSlow() {
		reset();
		ws?.send(JSON.stringify({ event: 'slow-signal', payload: {} }));
	}
	function cancelStream() {
		ws?.send(
			JSON.stringify({ event: '__streamCancel__', payload: {}, __wskit: { streamId: lastStreamId } }),
		);
	}
	function disconnect() {
		ws?.close();
	}
</script>

<h1>stream-signal feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="start-slow" onclick={startSlow}>Start slow-signal</button>
<button data-testid="cancel" onclick={cancelStream}>Cancel</button>
<button data-testid="disconnect" onclick={disconnect}>Disconnect</button>

<span data-testid="status">{status}</span>
<span data-testid="stream-id">{lastStreamId}</span>
<span data-testid="stream-ok">{streamOkReceived ? 'yes' : 'no'}</span>
<span data-testid="chunk-indices">{chunkIndices.join(',')}</span>
<span data-testid="signal-fired">{signalFired ? 'yes' : 'no'}</span>
<span data-testid="signal-aborted">{signalAborted}</span>
<span data-testid="signal-reason">{signalReason}</span>
<span data-testid="signal-ran-to-completion">{signalRanToCompletion}</span>
