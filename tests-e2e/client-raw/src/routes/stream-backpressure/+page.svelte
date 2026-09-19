<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastStreamId = $state('');
	let streamOkReceived = $state(false);
	let chunkIndices = $state<number[]>([]);
	let streamEnded = $state(false);

	function reset() {
		lastStreamId = '';
		streamOkReceived = false;
		chunkIndices = [];
		streamEnded = false;
	}

	function connect() {
		if (ws) return;

		status = 'connecting';
		reset();
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';

		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-backpressure?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			const data = window.__livethingDecode(ev.data);
			switch (data.event) {
				case '__streamOk__':
					streamOkReceived = true;
					if (data.metadata?.stream?.id) lastStreamId = data.metadata.stream?.id;
					break;

				case '__streamEnd__':
					streamEnded = true;
					break;

				case 'drain-feed':
					if (typeof data.payload?.index === 'number') {
						chunkIndices = [...chunkIndices, data.payload.index];
					}

					break;
			}
		};
	}

	function start5() {
		reset();
		ws?.send(window.__livethingEncode({ event: 'drain-feed', payload: { count: 5 } }));
	}

	function disconnect() {
		ws?.close();
	}
</script>

<h1>stream-backpressure feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="start-5" onclick={start5}>Start drain-feed (5)</button>
<button data-testid="disconnect" onclick={disconnect}>Disconnect</button>

<span data-testid="status">{status}</span>
<span data-testid="stream-id">{lastStreamId}</span>
<span data-testid="stream-ok">{streamOkReceived ? 'yes' : 'no'}</span>
<span data-testid="chunk-indices">{chunkIndices.join(',')}</span>
<span data-testid="stream-end">{streamEnded ? 'yes' : 'no'}</span>
