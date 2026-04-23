<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastEchoed = $state('');
	let asyncResult = $state('');
	let validationError = $state('');

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
			if (data.event === 'async-done') asyncResult = data.payload?.message ?? '';
			if (data.event === 'validation-error-fired') validationError = data.payload?.event ?? '';
		};
	}

	function sendPing(text: string) {
		ws?.send(JSON.stringify({ event: 'echo-ping', payload: { text } }));
	}

	function sendReplayNoOp() {
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
	}

	function sendBad() {
		ws?.send(JSON.stringify({ event: 'echo-ping', payload: { text: 123 } }));
	}

	function sendAsync() {
		ws?.send(JSON.stringify({ event: 'async-ping', payload: { delay: 50 } }));
	}

	function sendUnknown() {
		ws?.send(JSON.stringify({ event: 'unknown-event', payload: {} }));
	}

	function sendNoEvent() {
		ws?.send(JSON.stringify({ payload: { text: 'no event field' } }));
	}
</script>

<h1>incoming feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-hello" onclick={() => sendPing('hello')}>Send hello</button>
<button data-testid="send-replay" onclick={sendReplayNoOp}>Send _replay (no-op)</button>
<button data-testid="send-bad" onclick={sendBad}>Send bad</button>
<button data-testid="send-async" onclick={sendAsync}>Send async</button>
<button data-testid="send-unknown" onclick={sendUnknown}>Send unknown</button>
<button data-testid="send-no-event" onclick={sendNoEvent}>Send no event</button>
<span data-testid="status">{status}</span>
<span data-testid="echoed">{lastEchoed}</span>
<span data-testid="async-result">{asyncResult}</span>
<span data-testid="validation-error">{validationError}</span>
