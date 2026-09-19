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

	function recordRoomMessage(payload: Record<string, any>) {
		const channel = payload.channel ?? '';
		const entry = `${payload.from}:${payload.text}`;
		const target = payload.kind === 'system' ? systemMessagesByChannel : userMessagesByChannel;
		const next = { ...target, [channel]: [...(target[channel] ?? []), entry] };
		if (payload.kind === 'system') systemMessagesByChannel = next;
		else userMessagesByChannel = next;
	}

	const eventHandlers: Record<string, (data: any) => void> = {
		'top-only-action-fired': (data) => (topOnlyActionFired = data.payload?.from ?? ''),
		'validation-observed': (data) =>
			(validationObserved = `${data.payload?.channel ?? ''}|${data.payload?.event ?? ''}`),
		'scoped-error-observed': (data) =>
			(scopedErrorObserved = `${data.payload?.channel ?? ''}|${data.payload?.family ?? ''}|${data.payload?.event ?? ''}`),
		'__subscribeOk__': (data) => (subscribeOk = [...subscribeOk, data.metadata?.channel?.name ?? '']),
		'__error__': (data) => {
			if (!data.metadata?.channel?.name) return;

			subscribeError = `${data.metadata.channel?.name}:${data.payload.code}`;
			subscribeErrorScope = data.metadata.channel?.family ?? '';
		},
		'name-result': (data) => (nameResult = `${data.payload.name}|${data.payload.suffix}`),
		'room-message': (data) => recordRoomMessage(data.payload ?? {}),
	};

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

			const data = window.__livethingDecode(ev.data);
			eventHandlers[data.event]?.(data);
		};
	}

	function send(
		event: string,
		payload: Record<string, unknown> | null = null,
		metadata?: { channel?: string; family?: string },
	) {
		const wireMetadata = metadata?.channel
			? { channel: { name: metadata.channel, ...(metadata.family ? { family: metadata.family } : {}) } }
			: null;
		ws?.send(window.__livethingEncode({ event, payload, metadata: wireMetadata }));
	}

	function subscribe(channel: string) {
		send('__subscribe__', null, { channel, family: 'room' });
	}

	function subscribeNoScope(channel: string) {
		// Missing channelFamily — should emit __error__ channel-not-found.
		send('__subscribe__', null, { channel });
	}

	function subscribeUnknownScope(channel: string, scopeName: string) {
		send('__subscribe__', null, { channel, family: scopeName });
	}

	function echoName(channel: string) {
		send('echo-name', {}, { channel, family: 'room' });
	}

	function sendTo(channel: string, text: string) {
		send('send-message', { text }, { channel, family: 'room' });
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
