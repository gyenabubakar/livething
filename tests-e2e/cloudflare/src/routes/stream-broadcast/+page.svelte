<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let indices = $state<number[]>([]);
	let streamEnd = $state(false);

	function connect() {
		if (ws) return;
		status = 'connecting';
		indices = [];
		streamEnd = false;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-broadcast?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_streamEnd') streamEnd = true;
			if (data.event === 'start-broadcast' && typeof data.payload?.index === 'number') {
				indices = [...indices, data.payload.index];
			}
		};
	}

	function start(count: number) {
		indices = [];
		streamEnd = false;
		ws?.send(JSON.stringify({ event: 'start-broadcast', payload: { count } }));
	}
</script>

<h1>stream-broadcast feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="start-3" onclick={() => start(3)}>Start 3</button>
<span data-testid="status">{status}</span>
<span data-testid="indices">{indices.join(',')}</span>
<span data-testid="stream-end">{streamEnd ? 'yes' : 'no'}</span>
