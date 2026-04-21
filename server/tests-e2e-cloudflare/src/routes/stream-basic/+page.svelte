<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastStreamId = $state('');
	let streamOkReceived = $state(false);
	let chunkIndices = $state<number[]>([]);
	let streamError = $state('');
	let streamEnd = $state(false);
	let cancelOkReceived = $state(false);

	function reset() {
		lastStreamId = '';
		streamOkReceived = false;
		chunkIndices = [];
		streamError = '';
		streamEnd = false;
		cancelOkReceived = false;
	}

	function connect() {
		if (ws) return;
		status = 'connecting';
		reset();
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-basic?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			switch (data.event) {
				case '_streamOk':
					streamOkReceived = true;
					if (data.payload?._streamId) lastStreamId = data.payload._streamId;
					break;
				case '_streamEnd':
					streamEnd = true;
					break;
				case '_streamCancelOk':
					cancelOkReceived = true;
					break;
				case '_error':
					if (data.payload?._streamId) {
						streamError = `stream-error:${data.payload.code}`;
					}
					break;
				case 'start-tokens':
				case 'start-boom':
					if (typeof data.payload?.index === 'number') {
						chunkIndices = [...chunkIndices, data.payload.index];
					}
					break;
			}
		};
	}

	function startTokens(count: number) {
		reset();
		ws?.send(JSON.stringify({ event: 'start-tokens', payload: { count } }));
	}
	function startBoom() {
		reset();
		ws?.send(JSON.stringify({ event: 'start-boom', payload: {} }));
	}
	function cancelStream() {
		ws?.send(JSON.stringify({ event: '_streamCancel', payload: { _streamId: lastStreamId } }));
	}
</script>

<h1>stream-basic feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="start-3" onclick={() => startTokens(3)}>Start 3 tokens</button>
<button data-testid="start-10" onclick={() => startTokens(10)}>Start 10 tokens</button>
<button data-testid="start-boom" onclick={startBoom}>Start boom</button>
<button data-testid="cancel" onclick={cancelStream}>Cancel</button>

<span data-testid="status">{status}</span>
<span data-testid="stream-id">{lastStreamId}</span>
<span data-testid="stream-ok">{streamOkReceived ? 'yes' : 'no'}</span>
<span data-testid="chunk-indices">{chunkIndices.join(',')}</span>
<span data-testid="stream-error">{streamError}</span>
<span data-testid="stream-end">{streamEnd ? 'yes' : 'no'}</span>
<span data-testid="cancel-ok">{cancelOkReceived ? 'yes' : 'no'}</span>
