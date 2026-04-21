<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastEchoed = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/incoming?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'echo-pong') lastEchoed = data.payload?.text ?? '';
		};
	}

	function sendPing(text: string) {
		ws?.send(JSON.stringify({ event: 'echo-ping', payload: { text } }));
	}

	function sendReplayNoOp() {
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
	}
</script>

<h1>incoming feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-hello" onclick={() => sendPing('hello')}>Send hello</button>
<button data-testid="send-replay" onclick={sendReplayNoOp}>Send _replay (no-op)</button>
<span data-testid="status">{status}</span>
<span data-testid="echoed">{lastEchoed}</span>
