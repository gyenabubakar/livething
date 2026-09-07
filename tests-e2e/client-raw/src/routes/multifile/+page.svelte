<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let notifications = $state<string[]>([]);
	let roomMessages = $state<string[]>([]);
	let subscribed = $state(false);

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/multifile?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
			subscribed = false;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;

			const data = JSON.parse(ev.data);
			if (data.event === 'notification') {
				notifications = [...notifications, data.payload?.title ?? ''];
			}

			if (data.event === '__subscribeOk__') subscribed = true;
			if (data.event === 'room-message') {
				const text = data.payload?.text ?? '';
				const from = data.payload?.from ?? '';
				roomMessages = [...roomMessages, `${from}:${text}`];
			}
		};
	}

	function subscribe() {
		ws?.send(JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } }));
	}

	function sendRoomMessage(text: string) {
		ws?.send(
			JSON.stringify({
				event: 'send-room-message',
				payload: { text },
				__wskit: { channel: 'lobby' },
			}),
		);
	}
</script>

<h1>multifile feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe" onclick={subscribe} disabled={status !== 'connected'}>
	Subscribe
</button>
<button
	data-testid="send-hello"
	onclick={() => sendRoomMessage('hello')}
	disabled={!subscribed}
>
	Send hello
</button>
<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="notifications">{notifications.join('|')}</span>
<span data-testid="room-messages">{roomMessages.join('|')}</span>
