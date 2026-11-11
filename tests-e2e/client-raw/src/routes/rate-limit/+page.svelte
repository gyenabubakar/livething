<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('rl-user');
	let tockCount = $state(0);
	let expensiveDoneCount = $state(0);
	let rateLimitedCount = $state(0);
	let lastRetryAfterMs = $state<number | null>(null);
	let lastErrorCode = $state<string | null>(null);
	let inheritMsgCount = $state(0);
	let noLimitMsgCount = $state(0);
	let chatterMsgCount = $state(0);
	let subscribedNoLimit = $state(false);
	let subscribedInherit = $state(false);
	let subscribedRooms = $state(false);

	// correlationId tracking — we record per-id resolution as 'ok' / 'rate-limited' / other.
	let echoOutcomes = $state<Record<string, string>>({});
	let echoCounter = 0;

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/rate-limit?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			const data = window.__livethingDecode(ev.data);
			const cid = data.metadata?.exchange?.id as string | undefined;
			if (data.event === 'tock') {tockCount += 1;}
			else if (data.event === 'expensive-done') {expensiveDoneCount += 1;}
			else if (data.event === 'msg') {
				if (data.metadata?.channel?.name === 'inherit-room') inheritMsgCount += 1;
				else if (data.metadata?.channel?.name === 'no-limit') noLimitMsgCount += 1;
			} else if (data.event === 'chatter-broadcast') {chatterMsgCount += 1;}
			else if (data.event === 'echo-req' && cid) {
				echoOutcomes = { ...echoOutcomes, [cid]: 'ok' };
			} else if (data.event === '__subscribeOk__') {
				const ch = data.metadata?.channel?.name;
				if (ch === 'no-limit') subscribedNoLimit = true;
				else if (ch === 'inherit-room') subscribedInherit = true;
				else if (ch === 'rooms') subscribedRooms = true;
			} else if (data.event === '__error__') {
				lastErrorCode = data.payload?.code ?? null;
				if (data.payload?.code === 'rate-limited') {
					rateLimitedCount += 1;
					lastRetryAfterMs = data.payload?.detail?.retryAfterMs ?? null;
					if (cid) echoOutcomes = { ...echoOutcomes, [cid]: 'rate-limited' };
				} else if (cid) {
					echoOutcomes = { ...echoOutcomes, [cid]: 'other-error' };
				}
			}
		};
	}

	function send(
		event: string,
		payload: Record<string, unknown> | null = null,
		metadata?: Record<string, unknown>,
	) {
		ws?.send(window.__livethingEncode(metadata ? { event, payload, metadata } : { event, payload }));
	}

	function subscribe(channelName: string) {
		ws?.send(
			window.__livethingEncode({ event: '__subscribe__', payload: null, metadata: { channel: { name: channelName } } }),
		);
	}

	function sendEchoReq(text: string) {
		const id = `echo-${++echoCounter}`;
		ws?.send(
			window.__livethingEncode({
				event: 'echo-req',
				payload: { text },
				metadata: { exchange: { id: id } },
			}),
		);
		return id;
	}
</script>

<h1>rate-limit feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="tick" onclick={() => send('tick', {})}>Tick</button>
<button data-testid="expensive" onclick={() => send('expensive', {})}>Expensive</button>

<button data-testid="subscribe-no-limit" onclick={() => subscribe('no-limit')}>
	Subscribe no-limit
</button>
<button data-testid="subscribe-inherit" onclick={() => subscribe('inherit-room')}>
	Subscribe inherit
</button>
<button data-testid="subscribe-rooms" onclick={() => subscribe('rooms')}>
	Subscribe rooms
</button>
<button
	data-testid="send-no-limit"
	onclick={() => send('send', { text: 'hi' }, { channel: { name: 'no-limit' } })}
>
	Send in no-limit
</button>
<button
	data-testid="send-inherit"
	onclick={() => send('send', { text: 'hi' }, { channel: { name: 'inherit-room' } })}
>
	Send in inherit
</button>
<button
	data-testid="send-chatter"
	onclick={() => send('chatter', { text: 'hi' }, { channel: { name: 'rooms' } })}
>
	Send chatter
</button>

<button data-testid="echo-1" onclick={() => sendEchoReq('one')}>Echo req 1</button>
<button data-testid="echo-2" onclick={() => sendEchoReq('two')}>Echo req 2</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribed-no-limit">{subscribedNoLimit ? 'yes' : 'no'}</span>
<span data-testid="subscribed-inherit">{subscribedInherit ? 'yes' : 'no'}</span>
<span data-testid="subscribed-rooms">{subscribedRooms ? 'yes' : 'no'}</span>
<span data-testid="tock-count">{tockCount}</span>
<span data-testid="expensive-done-count">{expensiveDoneCount}</span>
<span data-testid="rate-limited-count">{rateLimitedCount}</span>
<span data-testid="last-retry-after-ms">{lastRetryAfterMs ?? ''}</span>
<span data-testid="last-error-code">{lastErrorCode ?? ''}</span>
<span data-testid="inherit-msg-count">{inheritMsgCount}</span>
<span data-testid="no-limit-msg-count">{noLimitMsgCount}</span>
<span data-testid="chatter-msg-count">{chatterMsgCount}</span>
<span data-testid="echo-1-outcome">{echoOutcomes['echo-1'] ?? ''}</span>
<span data-testid="echo-2-outcome">{echoOutcomes['echo-2'] ?? ''}</span>
