<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let echoCountByText = $state<Record<string, number>>({});
	let outgoingIds = $state<string[]>([]);

	function countFor(text: string) {
		return echoCountByText[text] ?? 0;
	}

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/dedup?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			if (data.event === 'echoed') {
				const text = data.payload?.text ?? '';
				echoCountByText = { ...echoCountByText, [text]: (echoCountByText[text] ?? 0) + 1 };
				const id = data.__wskit?.messageId;
				if (typeof id === 'string') outgoingIds = [...outgoingIds, id];
			}
		};
	}

	function sendEcho(text: string, messageId?: string) {
		const frame: Record<string, unknown> = { event: 'do-echo', payload: { text } };
		if (messageId) frame.__wskit = { messageId };
		ws?.send(JSON.stringify(frame));
	}
</script>

<h1>dedup feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="echo-plain" onclick={() => sendEcho('plain')}>Echo plain (no id)</button>
<button data-testid="echo-dup-id" onclick={() => sendEcho('dup-hi', 'fixed-123')}>
	Echo with fixed id
</button>
<button data-testid="echo-no-id" onclick={() => sendEcho('no-id')}>Echo no-id</button>

<span data-testid="status">{status}</span>
<span data-testid="count-plain">{countFor('plain')}</span>
<span data-testid="count-dup-hi">{countFor('dup-hi')}</span>
<span data-testid="count-no-id">{countFor('no-id')}</span>
<span data-testid="outgoing-ids">{outgoingIds.join(',')}</span>
