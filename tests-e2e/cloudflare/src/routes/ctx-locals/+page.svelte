<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let echoed = $state('');
	let subscribed = $state('no');

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
			if (data.event === '__subscribeOk__') subscribed = 'yes';
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

	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'room' } }));
	}

	function sendChannelEcho() {
		ws?.send(
			JSON.stringify({ event: 'echo', payload: { text: 'hello' }, __wskit: { channel: 'room' } }),
		);
	}
</script>

<h1>ctx-locals feature</h1>
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-echo" onclick={sendEcho}>Send echo</button>
<button data-testid="send-ns-echo" onclick={sendNsEcho}>Send ns echo</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>
<button data-testid="send-channel-echo" onclick={sendChannelEcho}>Send channel echo</button>
<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed}</span>
<span data-testid="echoed">{echoed}</span>
