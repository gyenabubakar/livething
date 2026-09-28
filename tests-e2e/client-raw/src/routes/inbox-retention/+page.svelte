<script lang="ts">
	type Frame = { event: string; payload: Record<string, unknown>; metadata?: Record<string, Record<string, unknown>> | null };

	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/inbox-retention?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		const win = window as unknown as { __ws?: WebSocket; __frames?: Frame[] };
		win.__frames = [];
		ws.onmessage = (ev) => {
			if (typeof ev.data === 'string') win.__frames!.push(window.__livethingDecode(ev.data));
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

<h1>inbox retention feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<span data-testid="status">{status}</span>
