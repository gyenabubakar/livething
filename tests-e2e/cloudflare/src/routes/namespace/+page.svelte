<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastNsMessage = $state('');
	let nameQueryResult = $state('');
	let responses = $state<Record<string, string>>({});
	let correlationCounter = 0;
	let nsStreamChunks = $state<number[]>([]);
	let nsStreamEnd = $state(false);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/namespace?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'ns-message') lastNsMessage = data.payload?.text ?? '';
			if (data.event === 'start-ns-stream' && typeof data.payload?.index === 'number') {
				nsStreamChunks = [...nsStreamChunks, data.payload.index];
			}
			if (data.event === '__streamEnd__') nsStreamEnd = true;
			const id = data.__wskit?.correlationId as string | undefined;
			if (id) {
				const payload = data.payload ?? {};
				responses = { ...responses, [id]: JSON.stringify(payload) };
				if (payload.namespace) {
					nameQueryResult = payload.namespace;
				}
			}
		};
	}

	function sendNs(text: string) {
		ws?.send(JSON.stringify({ event: 'send-ns', payload: { text }, __wskit: { namespace: 'ns' } }));
	}

	function broadcastNs(text: string) {
		ws?.send(
			JSON.stringify({ event: 'broadcast-ns', payload: { text }, __wskit: { namespace: 'ns' } }),
		);
	}

	function startNsStream(count: number) {
		nsStreamChunks = [];
		nsStreamEnd = false;
		ws?.send(
			JSON.stringify({ event: 'start-ns-stream', payload: { count }, __wskit: { namespace: 'ns' } }),
		);
	}

	function queryNsName() {
		const id = `req-${++correlationCounter}`;
		ws?.send(
			JSON.stringify({
				event: 'get-ns-info',
				payload: {},
				__wskit: { correlationId: id, namespace: 'ns' },
			}),
		);
	}
</script>

<h1>namespace feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-ns" onclick={() => sendNs('hello ns')}>Send ns hello</button>
<button data-testid="broadcast-ns" onclick={() => broadcastNs('broadcast msg')}>Broadcast ns msg</button>
<button data-testid="query-ns-name" onclick={queryNsName}>Query ns.name</button>
<button data-testid="start-ns-stream" onclick={() => startNsStream(3)}>Start ns stream</button>
<span data-testid="status">{status}</span>
<span data-testid="ns-message">{lastNsMessage}</span>
<span data-testid="ns-name-result">{nameQueryResult}</span>
<span data-testid="ns-stream-chunks">{nsStreamChunks.join(',')}</span>
<span data-testid="ns-stream-end">{nsStreamEnd ? 'yes' : 'no'}</span>
