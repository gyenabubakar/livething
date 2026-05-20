<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribeOkCount = $state(0);
	let subscribeOkChannels = $state<string[]>([]);
	let subscribeError = $state('');
	let userMessages = $state<string[]>([]);
	let systemMessages = $state<string[]>([]);
	let memberJoins = $state<string[]>([]);
	let memberLeaves = $state<string[]>([]);
	let channelStreamChunks = $state<number[]>([]);
	let channelStreamEnd = $state(false);
	let badBroadcastErrorCode = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/channel-static?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			const data = JSON.parse(ev.data);
			if (data.event === '__subscribeOk__') {
				subscribeOkCount += 1;
				subscribeOkChannels = [...subscribeOkChannels, data.__wskit?.channel ?? ''];
			}
			if (data.event === '__error__' && data.__wskit?.channel) {
				subscribeError = `${data.__wskit.channel}:${data.payload.code}`;
				if (data.__wskit.channel === 'room' && data.payload.code) {
					badBroadcastErrorCode = String(data.payload.code);
				}
			}
			if (data.event === '__memberJoin__' && data.__wskit?.channel) {
				memberJoins = [...memberJoins, `${data.__wskit.channel}:${data.payload.connectionId}`];
			}
			if (data.event === '__memberLeave__' && data.__wskit?.channel) {
				memberLeaves = [
					...memberLeaves,
					`${data.__wskit.channel}:${data.payload.connectionId}`,
				];
			}
			if (data.event === 'start-channel-stream' && typeof data.payload?.index === 'number') {
				channelStreamChunks = [...channelStreamChunks, data.payload.index];
			}
			if (data.event === '__streamEnd__' && data.__wskit?.channel === 'room') {
				channelStreamEnd = true;
			}
			if (data.event === 'room-message') {
				const entry = `${data.payload.from}:${data.payload.text}`;
				if (data.payload.kind === 'system') {
					systemMessages = [...systemMessages, entry];
				} else {
					userMessages = [...userMessages, entry];
				}
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
	function subscribeRoom() {
		send('__subscribe__', {}, { channel: 'room' });
	}
	function subscribeRoomTwo() {
		send('__subscribe__', {}, { channel: 'room2' });
	}
	function subscribeBogus() {
		send('__subscribe__', {}, { channel: 'does-not-exist' });
	}
	function unsubscribeRoom() {
		send('__unsubscribe__', {}, { channel: 'room' });
	}
	function sendRoom(text: string) {
		send('send-message', { text }, { channel: 'room' });
	}
	function publishWithoutSub(text: string) {
		// Same send, but this button is used WITHOUT subscribing first.
		send('send-message', { text }, { channel: 'room' });
	}
	function triggerBadBroadcast() {
		badBroadcastErrorCode = '';
		send('trigger-bad-broadcast', {}, { channel: 'room' });
	}
	function startChannelStream(count: number) {
		channelStreamChunks = [];
		channelStreamEnd = false;
		send('start-channel-stream', { count }, { channel: 'room' });
	}
</script>

<h1>channel-static feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>
<button data-testid="subscribe-room2" onclick={subscribeRoomTwo}>Subscribe room2</button>
<button data-testid="subscribe-bogus" onclick={subscribeBogus}>Subscribe bogus</button>
<button data-testid="unsubscribe-room" onclick={unsubscribeRoom}>Unsubscribe room</button>
<button data-testid="send-hello" onclick={() => sendRoom('hello')}>Send hello</button>
<button data-testid="publish-without-sub" onclick={() => publishWithoutSub('stray')}>
	Publish without sub
</button>
<button data-testid="start-channel-stream-3" onclick={() => startChannelStream(3)}>
	Start channel stream (3)
</button>
<button data-testid="trigger-bad-broadcast" onclick={triggerBadBroadcast}>
	Trigger bad broadcast
</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribe-ok-count">{subscribeOkCount}</span>
<span data-testid="subscribe-ok-channels">{subscribeOkChannels.join(',')}</span>
<span data-testid="subscribe-error">{subscribeError}</span>
<span data-testid="user-messages">{userMessages.join(',')}</span>
<span data-testid="system-messages">{systemMessages.join(',')}</span>
<span data-testid="member-joins">{memberJoins.join(' | ')}</span>
<span data-testid="member-leaves">{memberLeaves.join(' | ')}</span>
<span data-testid="channel-stream-chunks">{channelStreamChunks.join(',')}</span>
<span data-testid="channel-stream-end">{channelStreamEnd ? 'yes' : 'no'}</span>
<span data-testid="bad-broadcast-error-code">{badBroadcastErrorCode}</span>
