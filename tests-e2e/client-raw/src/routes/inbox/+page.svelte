<script lang="ts">
	type Frame = { event: string; payload: Record<string, unknown>; __wskit?: Record<string, unknown> };

	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/inbox?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		const win = window as unknown as { __ws?: WebSocket; __frames?: Frame[] };
		// Buffer every frame from socket creation so a spec never races the drain
		// that fires right after the server accepts a reconnect.
		win.__frames = [];
		ws.onmessage = (ev) => {
			if (typeof ev.data === 'string') win.__frames!.push(JSON.parse(ev.data));
		};
		ws.onopen = () => {
			status = 'connected';
			win.__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
	}
</script>

<h1>inbox feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<span data-testid="status">{status}</span>
