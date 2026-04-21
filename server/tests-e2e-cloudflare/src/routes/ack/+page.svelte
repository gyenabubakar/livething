<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastAckSeq = $state(0);
	let pongN = $state<number | null>(null);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ack?username=${encodeURIComponent(username)}`,
		);
		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			const data = JSON.parse(ev.data);
			if (data.event === '_ack') lastAckSeq = data.payload?.seq ?? 0;
			if (data.event === 'pong') pongN = data.payload?.n ?? null;
		};
	}

	function disconnect() {
		ws?.close();
	}

	function sendPing(n: number) {
		ws?.send(JSON.stringify({ event: 'ping', payload: { n } }));
	}
</script>

<h1>ack feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="disconnect" onclick={disconnect}>Disconnect</button>
<button data-testid="ping" onclick={() => sendPing(1)}>Ping</button>
<span data-testid="status">{status}</span>
<span data-testid="last-ack-seq">{lastAckSeq}</span>
<span data-testid="pong-n">{pongN ?? ''}</span>
