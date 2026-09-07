<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let messages = $state<string[]>([]);
	let connectionId = $state('');
	let delivery = $state('');
	let targetId = $state('');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-send?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'message') {
				messages = [...messages, `${data.payload.from}:${data.payload.text}`];
			}

			if (data.event === 'who-am-i-result') connectionId = data.payload?.connectionId ?? '';
			if (data.event === 'delivery-status') {
				delivery = data.payload?.delivered ? 'true' : 'false';
			}
		};
	}

	function doBroadcast(text: string) {
		ws?.send(JSON.stringify({ event: 'do-broadcast', payload: { text } }));
	}

	function doBroadcastExcludeSelf(text: string) {
		ws?.send(JSON.stringify({ event: 'do-broadcast-exclude-self', payload: { text } }));
	}

	function doSendTo(tag: string, text: string) {
		ws?.send(JSON.stringify({ event: 'do-send-to', payload: { tag, text } }));
	}

	function doSendToEmpty(text: string) {
		ws?.send(JSON.stringify({ event: 'do-send-to-empty', payload: { text } }));
	}

	function doSendToConnection(connectionId: string, text: string) {
		ws?.send(
			JSON.stringify({ event: 'do-send-to-connection', payload: { connectionId, text } }),
		);
	}

	function whoAmI() {
		ws?.send(JSON.stringify({ event: 'who-am-i', payload: {} }));
	}

	function serverClose() {
		ws?.send(JSON.stringify({ event: 'do-server-close', payload: {} }));
	}
</script>

<h1>ctx-send feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="who-am-i" onclick={whoAmI}>Who am I</button>
<button data-testid="broadcast-hello" onclick={() => doBroadcast('hello')}>Broadcast hello</button>
<button data-testid="broadcast-excl-hello" onclick={() => doBroadcastExcludeSelf('hello-excl')}>
	Broadcast excl hello
</button>
<button data-testid="send-to-self" onclick={() => doSendTo(username, 'tagged')}>SendTo self</button>
<button data-testid="send-to-vip" onclick={() => doSendTo('vip', 'vip-tagged')}>SendTo vip</button>
<button data-testid="send-to-empty" onclick={() => doSendToEmpty('empty-tag')}>SendTo empty</button>
<input data-testid="target-id" bind:value={targetId} placeholder="target connection id" />
<button data-testid="send-to-target" onclick={() => doSendToConnection(targetId, 'direct-to-target')}>
	SendToConnection (target id)
</button>
<button data-testid="send-to-unknown" onclick={() => doSendToConnection('nope', 'ghost')}>
	SendToConnection (unknown)
</button>
<button data-testid="server-close" onclick={serverClose}>Server close</button>

<span data-testid="status">{status}</span>
<span data-testid="connection-id">{connectionId}</span>
<span data-testid="delivery">{delivery}</span>
<span data-testid="messages">{messages.join(',')}</span>
