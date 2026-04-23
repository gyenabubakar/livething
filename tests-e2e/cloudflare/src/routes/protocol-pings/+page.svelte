<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastMessage = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/protocol-pings?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			lastMessage = typeof ev.data === 'string' ? ev.data : '';
		};
	}

	function sendRawPing() {
		ws?.send('ping');
	}

	function sendJsonPing() {
		ws?.send(JSON.stringify({ event: 'ping' }));
	}

	if (typeof window !== 'undefined') {
		(window as unknown as Record<string, unknown>).__ws = () => ws;
	}
</script>

<h1>protocol-pings feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="raw-ping" onclick={sendRawPing}>Raw ping</button>
<button data-testid="json-ping" onclick={sendJsonPing}>JSON ping</button>
<span data-testid="status">{status}</span>
<span data-testid="last-message">{lastMessage}</span>
