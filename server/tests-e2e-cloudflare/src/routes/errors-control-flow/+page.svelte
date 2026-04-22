<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let echoResult = $state('');
	let blockReply = $state('');
	let deferResult = $state('');
	let deferExhausted = $state('');
	let validationError = $state('');
	let chatSubscribed = $state(false);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/errors-control-flow?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			switch (data.event) {
				case 'echoed':
					echoResult = data.payload?.text ?? '';
					break;
				case 'block-reply':
					blockReply = `leaked:${data.payload?.leaked}`;
					break;
				case 'defer-result':
					deferResult = 'deferred-received';
					break;
				case 'defer-exhausted-result':
					deferExhausted = `${data.payload?.event}:retries=${data.payload?.retries}`;
					break;
				case 'validation-error-fired':
					validationError = `validation-error:${data.payload?.event}`;
					break;
				case '_subscribeOk':
					chatSubscribed = true;
					break;
			}
		};
	}

	function send(event: string, payload: Record<string, unknown> = {}) {
		ws?.send(JSON.stringify({ event, payload }));
	}
</script>

<h1>errors-control-flow feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="do-echo" onclick={() => send('do-echo', { text: 'alive' })}>Do echo</button>
<button data-testid="block-test" onclick={() => send('block-test')}>Block test</button>
<button data-testid="defer-test" onclick={() => send('defer-test')}>Defer test</button>
<button data-testid="always-defer" onclick={() => send('always-defer')}>Always defer</button>
<button data-testid="manual-validation" onclick={() => send('manual-validation')}>
	Manual validation failed
</button>
<button data-testid="force-disconnect" onclick={() => send('force-disconnect')}>
	Force disconnect
</button>
<button data-testid="subscribe-chat" onclick={() => send('_subscribe', { _channel: 'chat' })}>
	Subscribe chat
</button>
<button
	data-testid="chat-always-defer"
	onclick={() => send('chat-always-defer', { _channel: 'chat' })}
>
	Chat always defer
</button>

<span data-testid="status">{status}</span>
<span data-testid="echo-result">{echoResult}</span>
<span data-testid="block-reply">{blockReply}</span>
<span data-testid="defer-result">{deferResult}</span>
<span data-testid="defer-exhausted">{deferExhausted}</span>
<span data-testid="validation-error">{validationError}</span>
<span data-testid="chat-subscribed">{chatSubscribed ? 'yes' : 'no'}</span>
