<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('user');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${proto}//${location.host}/ws/replay-family-key-equals-name?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		ws.onopen = () => {
			status = 'connected';
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
	}
</script>

<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<span data-testid="status">{status}</span>
