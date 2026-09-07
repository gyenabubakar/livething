<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastRequest = $state<{ action: string; correlationId: string } | null>(null);
	let outcome = $state('');
	let errorOutcome = $state('');
	let ackOutcome = $state('');
	let undeclaredOutcome = $state('');
	let undeclaredSeen = $state('');
	// How to answer the next server→client request: 'good' echoes a valid
	// response, 'bad' echoes a schema-violating one, 'drop' answers nothing,
	// 'decline' replies with the `__error__` frame a typed client sends when its
	// handler throws (or it has no handler) — the server must fast-fail.
	let answerMode = $state<'good' | 'bad' | 'drop' | 'decline'>('good');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/server-request?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			if (data.event === 'ask-permission' && correlationId) {
				lastRequest = { action: data.payload?.action ?? '', correlationId };
				if (answerMode === 'drop') return;

				if (answerMode === 'decline') {
					ws?.send(
						JSON.stringify({
							event: '__error__',
							payload: { code: 'request-no-response' },
							__wskit: { correlationId },
						}),
					);
					return;
				}

				const payload =
					answerMode === 'good' ? { allowed: true } : { allowed: 'not-a-boolean' };
				ws?.send(JSON.stringify({ event: 'ask-permission', payload, __wskit: { correlationId } }));

				return;
			}

			if (data.event === 'ping-ack' && correlationId) {
				ws?.send(
					JSON.stringify({ event: 'ping-ack', payload: { sneaky: true }, __wskit: { correlationId } }),
				);
				return;
			}

			if (data.event === 'undeclared-question' && correlationId) {
				undeclaredSeen = String(data.payload?.action ?? '');
				ws?.send(
					JSON.stringify({
						event: 'undeclared-question',
						payload: { ok: true },
						__wskit: { correlationId },
					}),
				);
				return;
			}

			if (data.event === 'outcome') outcome = String(data.payload?.allowed);
			if (data.event === 'error-outcome') errorOutcome = String(data.payload?.code);
			if (data.event === 'ack-outcome') ackOutcome = String(data.payload?.received);
			if (data.event === 'undeclared-outcome') undeclaredOutcome = String(data.payload?.status);
		};
	}

	function trigger() {
		outcome = '';
		errorOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger', payload: { action: 'delete' } }));
	}

	function triggerTimeout() {
		outcome = '';
		errorOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger-timeout', payload: {} }));
	}

	function triggerAck() {
		ackOutcome = '';
		ws?.send(JSON.stringify({ event: 'trigger-ack', payload: {} }));
	}

	function triggerUndeclared() {
		undeclaredOutcome = '';
		undeclaredSeen = '';
		ws?.send(JSON.stringify({ event: 'trigger-undeclared', payload: {} }));
	}
</script>

<h1>server→client request feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="answer-good" onclick={() => (answerMode = 'good')}>Answer good</button>
<button data-testid="answer-bad" onclick={() => (answerMode = 'bad')}>Answer bad</button>
<button data-testid="answer-drop" onclick={() => (answerMode = 'drop')}>Answer drop</button>
<button data-testid="answer-decline" onclick={() => (answerMode = 'decline')}>Answer decline</button>
<button data-testid="trigger" onclick={trigger}>Trigger</button>
<button data-testid="trigger-timeout" onclick={triggerTimeout}>Trigger (timeout)</button>
<button data-testid="trigger-ack" onclick={triggerAck}>Trigger (ack)</button>
<button data-testid="trigger-undeclared" onclick={triggerUndeclared}>Trigger (undeclared)</button>
<span data-testid="status">{status}</span>
<span data-testid="ask-action">{lastRequest?.action ?? ''}</span>
<span data-testid="outcome">{outcome}</span>
<span data-testid="error-outcome">{errorOutcome}</span>
<span data-testid="ack-outcome">{ackOutcome}</span>
<span data-testid="undeclared-outcome">{undeclaredOutcome}</span>
<span data-testid="undeclared-seen">{undeclaredSeen}</span>
