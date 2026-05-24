<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let echoed = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-locals?username=testuser&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'echoed') echoed = data.payload?.text ?? '';
		};
	}

	function sendEcho() {
		ws?.send(JSON.stringify({ event: 'echo', payload: { text: 'hello' } }));
	}

	function sendNsEcho() {
		ws?.send(
			JSON.stringify({ event: 'echo', payload: { text: 'hello' }, __wskit: { namespace: 'ns' } }),
		);
	}
</script>

<h1>ctx-locals feature</h1>
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-echo" onclick={sendEcho}>Send echo</button>
<button data-testid="send-ns-echo" onclick={sendNsEcho}>Send ns echo</button>
<span data-testid="status">{status}</span>
<span data-testid="echoed">{echoed}</span>
