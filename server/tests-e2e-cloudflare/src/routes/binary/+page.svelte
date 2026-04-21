<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastSize = $state<number | null>(null);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/binary?username=${encodeURIComponent(username)}`,
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
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			if (data.event === 'binary-echoed') lastSize = data.payload?.size ?? null;
		};
	}

	function disconnect() {
		ws?.close();
	}

	function sendBytes(n: number) {
		ws?.send(new Uint8Array(n).buffer);
	}
</script>

<h1>binary feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="disconnect" onclick={disconnect}>Disconnect</button>
<button data-testid="send-8" onclick={() => sendBytes(8)}>Send 8 bytes</button>
<span data-testid="status">{status}</span>
<span data-testid="last-size">{lastSize ?? ''}</span>
