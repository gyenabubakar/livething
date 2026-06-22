<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribeOk = $state<string[]>([]);
	let subscribeError = $state('');
	let subscribeErrorScope = $state('');
	let nameResult = $state('');
	let topOnlyActionFired = $state('');
	let validationObserved = $state('');
	let scopedErrorObserved = $state('');
	let userMessagesByChannel = $state<Record<string, string[]>>({});
	let systemMessagesByChannel = $state<Record<string, string[]>>({});

	function userMessagesFor(channel: string) {
		return (userMessagesByChannel[channel] ?? []).join(',');
	}
	function systemMessagesFor(channel: string) {
		return (systemMessagesByChannel[channel] ?? []).join(',');
	}

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/channel-dynamic?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
			// Expose for tests that need to send raw frames (e.g. protocol events).
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			if (data.event === 'top-only-action-fired') {
				topOnlyActionFired = data.payload?.from ?? '';
			}
			if (data.event === 'validation-observed') {
				validationObserved = `${data.payload?.channel ?? ''}|${data.payload?.event ?? ''}`;
			}
			if (data.event === 'scoped-error-observed') {
				scopedErrorObserved = `${data.payload?.channel ?? ''}|${data.payload?.family ?? ''}|${data.payload?.event ?? ''}`;
			}
			if (data.event === '__subscribeOk__') {
				subscribeOk = [...subscribeOk, data.__wskit?.channel ?? ''];
			}
			if (data.event === '__error__' && data.__wskit?.channel) {
				subscribeError = `${data.__wskit.channel}:${data.payload.code}`;
				subscribeErrorScope = data.__wskit.channelFamily ?? '';
			}
			if (data.event === 'name-result') {
				nameResult = `${data.payload.name}|${data.payload.suffix}`;
			}
			if (data.event === 'room-message') {
				const ch = data.payload?.channel ?? '';
				const entry = `${data.payload.from}:${data.payload.text}`;
				const target = data.payload.kind === 'system' ? systemMessagesByChannel : userMessagesByChannel;
				const next = { ...target, [ch]: [...(target[ch] ?? []), entry] };
				if (data.payload.kind === 'system') systemMessagesByChannel = next;
				else userMessagesByChannel = next;
			}
		};
	}

	function send(
		event: string,
		payload: Record<string, unknown> = {},
		__wskit?: Record<string, unknown>,
	) {
		ws?.send(JSON.stringify(__wskit ? { event, payload, __wskit } : { event, payload }));
	}
	function subscribe(channel: string) {
		send('__subscribe__', {}, { channel, channelFamily: 'room' });
	}
	function subscribeNoScope(channel: string) {
		// Missing channelFamily — should emit __error__ channel-not-found.
		send('__subscribe__', {}, { channel });
	}
	function subscribeUnknownScope(channel: string, scopeName: string) {
		send('__subscribe__', {}, { channel, channelFamily: scopeName });
	}
	function echoName(channel: string) {
		send('echo-name', {}, { channel, channelFamily: 'room' });
	}
	function sendTo(channel: string, text: string) {
		send('send-message', { text }, { channel, channelFamily: 'room' });
	}
</script>

<h1>channel-dynamic feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="sub-general" onclick={() => subscribe('room:general')}>Subscribe room:general</button>
<button data-testid="sub-vip" onclick={() => subscribe('room:vip')}>Subscribe room:vip</button>
<button data-testid="sub-zzz-no-scope" onclick={() => subscribeNoScope('zzz')}>Subscribe bogus</button>
<button
	data-testid="sub-unknown-scope"
	onclick={() => subscribeUnknownScope('room:x', 'unknown-family')}
>
	Subscribe unknown-family
</button>
<button
	data-testid="sub-name-fails-regex"
	onclick={() => subscribeUnknownScope('admin', 'room')}
>
	Subscribe name-fails-regex
</button>
<button data-testid="sub-alpha-123" onclick={() => subscribe('room:alpha-123')}>
	Subscribe room:alpha-123
</button>
<button data-testid="echo-name-general" onclick={() => echoName('room:general')}>
	Echo name general
</button>
<button data-testid="echo-name-alpha-123" onclick={() => echoName('room:alpha-123')}>
	Echo name alpha-123
</button>
<button data-testid="send-general" onclick={() => sendTo('room:general', 'hello-general')}>
	Send general
</button>
<button data-testid="send-vip" onclick={() => sendTo('room:vip', 'hello-vip')}>Send vip</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribe-ok">{subscribeOk.join(',')}</span>
<span data-testid="subscribe-error">{subscribeError}</span>
<span data-testid="subscribe-error-scope">{subscribeErrorScope}</span>
<span data-testid="name-result">{nameResult}</span>
<span data-testid="user-msgs-general">{userMessagesFor('room:general')}</span>
<span data-testid="user-msgs-vip">{userMessagesFor('room:vip')}</span>
<span data-testid="system-msgs-general">{systemMessagesFor('room:general')}</span>
<span data-testid="top-only-action-fired">{topOnlyActionFired}</span>
<span data-testid="validation-observed">{validationObserved}</span>
<span data-testid="scoped-error-observed">{scopedErrorObserved}</span>
