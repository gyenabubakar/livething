<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let errorResult = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/errors-factory?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_error') {
				errorResult = `${data.payload?.code ?? ''}:${JSON.stringify(data.payload?.detail ?? {})}`;
			}
		};
	}

	function triggerNotFound() {
		ws?.send(JSON.stringify({ event: 'trigger-not-found', payload: {} }));
	}
	function triggerForbidden() {
		ws?.send(JSON.stringify({ event: 'trigger-forbidden', payload: {} }));
	}
</script>

<h1>errors-factory feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="trigger-not-found" onclick={triggerNotFound}>Trigger not-found</button>
<button data-testid="trigger-forbidden" onclick={triggerForbidden}>Trigger forbidden</button>
<span data-testid="status">{status}</span>
<span data-testid="error-result">{errorResult}</span>
