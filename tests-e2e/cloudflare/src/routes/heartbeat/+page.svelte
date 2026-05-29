<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let closeCode = $state<number | null>(null);

	function connect() {
		if (ws) return;
		status = 'connecting';
		closeCode = null;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = new URL(location.href);
		const room = url.searchParams.get('room') ?? 'default';
		// With ?autopong=1 the page answers the server's keepalive "ping" text
		// frame with "pong" — a live-but-app-silent client. Without it, the raw
		// socket never replies, so the server sees a client that has gone away.
		const autoPong = url.searchParams.get('autopong') === '1';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/heartbeat?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
		};
		ws.onmessage = (ev) => {
			if (autoPong && ev.data === 'ping') ws?.send('pong');
		};
		ws.onclose = (ev) => {
			closeCode = ev.code;
			status = 'disconnected';
			ws = null;
		};
	}

	function sendEcho() {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'echo', timestamp: Date.now() }));
		}
	}
</script>

<h1>heartbeat feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-echo" onclick={sendEcho}>Send Echo</button>
<span data-testid="status">{status}</span>
<span data-testid="close-code">{closeCode ?? ''}</span>
