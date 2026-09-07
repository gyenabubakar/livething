<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let lastTurn = $state<number | null>(null);
	let outcomeFrom = $state('');
	let outcomeReady = $state('');
	let errorOutcome = $state('');
	// How this client answers a broadcast `volunteer` request: 'good' echoes a
	// valid answer, 'bad' a schema-violating one, 'drop' stays silent.
	let answerMode = $state<'good' | 'bad' | 'drop'>('good');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/broadcast-request?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			const correlationId = data.__wskit?.correlationId;

			if (data.event === '__subscribeOk__') {
				subscribed = true;
				return;
			}

			if (data.event === 'volunteer' && correlationId) {
				lastTurn = data.payload?.turn ?? null;
				if (answerMode === 'drop') return;

				const payload = answerMode === 'good' ? { ready: true } : { ready: 'not-a-boolean' };
				ws?.send(
					JSON.stringify({
						event: 'volunteer',
						payload,
						__wskit: { correlationId, channel: data.__wskit?.channel },
					}),
				);
				return;
			}

			if (data.event === 'outcome') {
				outcomeFrom = String(data.payload?.from ?? '');
				outcomeReady = String(data.payload?.ready ?? '');
			}

			if (data.event === 'error-outcome') errorOutcome = String(data.payload?.code);
		};
	}

	function subscribe() {
		ws?.send(JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } }));
	}

	function trigger() {
		outcomeFrom = '';
		outcomeReady = '';
		errorOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger', payload: { turn: 5 } }));
	}

	function triggerTimeout() {
		outcomeFrom = '';
		outcomeReady = '';
		errorOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger-timeout', payload: { turn: 9 } }));
	}
</script>

<h1>broadcast request feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe" onclick={subscribe}>Subscribe</button>
<button data-testid="answer-good" onclick={() => (answerMode = 'good')}>Answer good</button>
<button data-testid="answer-bad" onclick={() => (answerMode = 'bad')}>Answer bad</button>
<button data-testid="answer-drop" onclick={() => (answerMode = 'drop')}>Answer drop</button>
<button data-testid="trigger" onclick={trigger}>Trigger</button>
<button data-testid="trigger-timeout" onclick={triggerTimeout}>Trigger (timeout)</button>
<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed}</span>
<span data-testid="last-turn">{lastTurn ?? ''}</span>
<span data-testid="outcome-from">{outcomeFrom}</span>
<span data-testid="outcome-ready">{outcomeReady}</span>
<span data-testid="error-outcome">{errorOutcome}</span>
