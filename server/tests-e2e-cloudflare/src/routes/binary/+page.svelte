<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastBinarySize = $state<number | null>(null);
	let receivedSizes = $state<number[]>([]);
	let metaUsername = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/binary?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (ev.data instanceof ArrayBuffer) {
				lastBinarySize = ev.data.byteLength;
				receivedSizes = [...receivedSizes, ev.data.byteLength];
				return;
			}
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			if (data.event === 'binary-meta') {
				lastBinarySize = data.payload?.size ?? null;
				receivedSizes = [...receivedSizes, data.payload?.size];
				metaUsername = data.payload?.username ?? '';
			}
		};
	}

	function sendBytes(n: number) {
		ws?.send(new Uint8Array(n).buffer);
	}

	function broadcastAll(size: number) {
		ws?.send(JSON.stringify({ event: 'broadcast-all', payload: { size } }));
	}

	function broadcastExcludeSelf(size: number) {
		ws?.send(JSON.stringify({ event: 'broadcast-exclude-self', payload: { size } }));
	}
</script>

<h1>binary feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-5" onclick={() => sendBytes(5)}>Send 5 bytes</button>
<button data-testid="broadcast-all-6" onclick={() => broadcastAll(6)}>Broadcast 6 bytes (all)</button>
<button data-testid="broadcast-all-8" onclick={() => broadcastAll(8)}>Broadcast 8 bytes (all)</button>
<button data-testid="broadcast-exclude-self-6" onclick={() => broadcastExcludeSelf(6)}>
	Broadcast 6 bytes (exclude self)
</button>
<span data-testid="status">{status}</span>
<span data-testid="last-size">{lastBinarySize ?? ''}</span>
<span data-testid="received-sizes">{receivedSizes.join(',')}</span>
<span data-testid="meta-username">{metaUsername}</span>
