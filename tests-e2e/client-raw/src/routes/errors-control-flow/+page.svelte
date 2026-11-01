<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let echoResult = $state('');
	let blockReply = $state('');
	let validationError = $state('');

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

			const data = window.__livethingDecode(ev.data);
			switch (data.event) {
				case 'echoed':
					echoResult = data.payload?.text ?? '';
					break;

				case 'block-reply':
					blockReply = `leaked:${data.payload?.leaked}`;
					break;

				case 'validation-error-fired':
					validationError = `validation-error:${data.payload?.event}`;
					break;
			}
		};
	}

	function send(event: string, payload: Record<string, unknown> | null = null) {
		ws?.send(window.__livethingEncode({ event, payload }));
	}
</script>

<h1>errors-control-flow feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="do-echo" onclick={() => send('do-echo', { text: 'alive' })}>Do echo</button>
<button data-testid="block-test" onclick={() => send('block-test', {})}>Block test</button>
<button data-testid="manual-validation" onclick={() => send('manual-validation', {})}>
	Manual validation failed
</button>
<button data-testid="force-disconnect" onclick={() => send('force-disconnect', {})}>
	Force disconnect
</button>
<button data-testid="disconnect-intercept" onclick={() => send('disconnect-intercept', {})}>
	Disconnect from intercept
</button>

<span data-testid="status">{status}</span>
<span data-testid="echo-result">{echoResult}</span>
<span data-testid="block-reply">{blockReply}</span>
<span data-testid="validation-error">{validationError}</span>
