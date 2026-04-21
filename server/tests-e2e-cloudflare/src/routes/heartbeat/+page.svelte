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
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/heartbeat?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = (ev) => {
			closeCode = ev.code;
			status = 'disconnected';
			ws = null;
		};
	}
</script>

<h1>heartbeat feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<span data-testid="status">{status}</span>
<span data-testid="close-code">{closeCode ?? ''}</span>
