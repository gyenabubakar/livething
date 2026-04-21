<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribeOk = $state<string[]>([]);
	let subscribeError = $state('');
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
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			if (data.event === '_subscribeOk') {
				subscribeOk = [...subscribeOk, data.payload?._channel ?? ''];
			}
			if (data.event === '_error' && data.payload?._channel) {
				subscribeError = `${data.payload._channel}:${data.payload.code}`;
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

	function send(event: string, payload: Record<string, unknown> = {}) {
		ws?.send(JSON.stringify({ event, payload }));
	}
	function subscribe(channel: string) {
		send('_subscribe', { _channel: channel, _channelScope: 'room' });
	}
	function subscribeNoScope(channel: string) {
		// Missing _channelScope — should emit _error channel-not-found.
		send('_subscribe', { _channel: channel });
	}
	function sendTo(channel: string, text: string) {
		send('send-message', { text, _channel: channel, _channelScope: 'room' });
	}
</script>

<h1>channel-dynamic feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="sub-general" onclick={() => subscribe('room:general')}>Subscribe room:general</button>
<button data-testid="sub-vip" onclick={() => subscribe('room:vip')}>Subscribe room:vip</button>
<button data-testid="sub-zzz-no-scope" onclick={() => subscribeNoScope('zzz')}>Subscribe bogus</button>
<button data-testid="send-general" onclick={() => sendTo('room:general', 'hello-general')}>
	Send general
</button>
<button data-testid="send-vip" onclick={() => sendTo('room:vip', 'hello-vip')}>Send vip</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribe-ok">{subscribeOk.join(',')}</span>
<span data-testid="subscribe-error">{subscribeError}</span>
<span data-testid="user-msgs-general">{userMessagesFor('room:general')}</span>
<span data-testid="user-msgs-vip">{userMessagesFor('room:vip')}</span>
<span data-testid="system-msgs-general">{systemMessagesFor('room:general')}</span>
