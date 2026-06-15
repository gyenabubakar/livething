<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastEvent = $state<{ theme: string; ackId: string } | null>(null);
	let outcome = $state('');
	let errorOutcome = $state('');
	// How to handle the next server-initiated sendWithAck: 'confirm' echoes the
	// __ack__ receipt (what the real client does automatically); 'drop' never
	// confirms, so the server's promise times out.
	let ackMode = $state<'confirm' | 'drop'>('confirm');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/server-ack?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			const ackId = data.__wskit?.ackId;

			// A server-initiated sendWithAck: a normal event stamped with an ackId.
			if (data.event === 'settings-updated' && ackId) {
				lastEvent = { theme: data.payload?.theme ?? '', ackId };
				if (ackMode === 'drop') return;
				ws?.send(JSON.stringify({ event: '__ack__', payload: {}, __wskit: { ackId } }));
				return;
			}

			if (data.event === 'ack-outcome') outcome = String(data.payload?.ok);
			if (data.event === 'ack-error') errorOutcome = String(data.payload?.code);
		};
	}

	function trigger() {
		outcome = '';
		errorOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger', payload: {} }));
	}

	function triggerTimeout() {
		outcome = '';
		errorOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger-timeout', payload: {} }));
	}
</script>

<h1>server→client ack feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="ack-confirm" onclick={() => (ackMode = 'confirm')}>Confirm</button>
<button data-testid="ack-drop" onclick={() => (ackMode = 'drop')}>Drop</button>
<button data-testid="trigger" onclick={trigger}>Trigger</button>
<button data-testid="trigger-timeout" onclick={triggerTimeout}>Trigger (timeout)</button>
<span data-testid="status">{status}</span>
<span data-testid="acked-theme">{lastEvent?.theme ?? ''}</span>
<span data-testid="outcome">{outcome}</span>
<span data-testid="error-outcome">{errorOutcome}</span>
