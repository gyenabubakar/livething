<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let greetings = $state<string[]>([]);
	let ackIds = $state<string[]>([]);
	let pongResponse = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/full-import?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'greeting') greetings = [...greetings, data.payload?.text ?? ''];
			if (data.event === '_ack' && data.payload?._ackId) {
				ackIds = [...ackIds, data.payload._ackId];
			}
			// Request response: any frame with a _correlationId in the payload.
			// Show event + full payload so the test can read both.
			if (data.payload?._correlationId) {
				pongResponse = JSON.stringify({ event: data.event, payload: data.payload });
			}
		};
	}

	function sendSayHi(name: string, ackId: string) {
		ws?.send(JSON.stringify({ event: 'say-hi', payload: { name, _ackId: ackId } }));
	}

	function sendPing() {
		ws?.send(
			JSON.stringify({ event: 'time-check', payload: { ts: 42, _correlationId: 'req-1' } }),
		);
	}
</script>

<h1>full-import feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-hi" onclick={() => sendSayHi('alice', 'ack-1')}>Say hi to alice</button>
<button data-testid="send-ping" onclick={sendPing}>Send ping (request)</button>
<span data-testid="status">{status}</span>
<span data-testid="greetings">{greetings.join('|')}</span>
<span data-testid="ack-ids">{ackIds.join(',')}</span>
<span data-testid="pong">{pongResponse}</span>
