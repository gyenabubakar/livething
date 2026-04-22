<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let echoed = $state<string[]>([]);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/intercept?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_subscribeOk') subscribed = true;
			if (data.event === 'echoed') echoed = [...echoed, data.payload?.text ?? ''];
		};
	}

	function send(text: string, scope?: 'ns' | 'room') {
		const payload: Record<string, unknown> = { text };
		if (scope === 'ns') payload._namespace = 'ns';
		if (scope === 'room') payload._channel = 'room';
		ws?.send(JSON.stringify({ event: 'echo', payload }));
	}
	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '_subscribe', payload: { _channel: 'room' } }));
	}
</script>

<h1>intercept feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>

<button data-testid="send-top-pre" onclick={() => send('top-pre')}>Send top-pre</button>
<button data-testid="send-top-post" onclick={() => send('top-post')}>Send top-post</button>
<button data-testid="send-top-passthrough" onclick={() => send('top-passthrough')}>Send top-passthrough</button>
<button data-testid="send-top-post-passthrough" onclick={() => send('top-post-passthrough')}>Send top-post-passthrough</button>
<button data-testid="send-top-chain" onclick={() => send('top-chain')}>Send top-chain</button>
<button data-testid="send-top-post-block" onclick={() => send('top-post-block')}>Send top-post-block</button>
<button data-testid="send-ns-pre" onclick={() => send('ns-pre', 'ns')}>Send ns-pre</button>
<button data-testid="send-ns-post" onclick={() => send('ns-post', 'ns')}>Send ns-post</button>
<button data-testid="send-ns-pre-block" onclick={() => send('ns-pre-block', 'ns')}>Send ns-pre-block</button>
<button data-testid="send-ch-pre" onclick={() => send('ch-pre', 'room')}>Send ch-pre</button>
<button data-testid="send-ch-post" onclick={() => send('ch-post', 'room')}>Send ch-post</button>
<button data-testid="send-ch-pre-block" onclick={() => send('ch-pre-block', 'room')}>Send ch-pre-block</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="echoed">{echoed.join(',')}</span>
