<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let quality = $state('');
	let latency = $state<number | null>(null);
	let buffered = $state<number | null>(null);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-quality?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'quality-result') {
				quality = data.payload?.quality ?? '';
				latency = data.payload?.latency ?? null;
				buffered = data.payload?.bufferedAmount ?? null;
			}
		};
	}

	function getQuality() {
		ws?.send(JSON.stringify({ event: 'get-quality', payload: {} }));
	}
</script>

<h1>ctx-quality feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="get-quality" onclick={getQuality}>Get quality</button>
<span data-testid="status">{status}</span>
<span data-testid="quality">{quality}</span>
<span data-testid="latency">{latency ?? ''}</span>
<span data-testid="buffered">{buffered ?? ''}</span>
