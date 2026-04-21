<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let membersResult = $state('');
	let kickedResult = $state('');
	let roomMessages = $state<string[]>([]);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-channels?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_subscribeOk') subscribed = true;
			if (data.event === 'members-result') {
				membersResult = `${data.payload.channel}:${data.payload.count}`;
			}
			if (data.event === '_kicked') {
				kickedResult = `kicked:${data.payload._channel}:${data.payload.reason ?? ''}`;
			}
			if (data.event === 'room-message') {
				roomMessages = [...roomMessages, `${data.payload.from}:${data.payload.text}`];
			}
		};
	}

	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '_subscribe', payload: { _channel: 'room' } }));
	}
	function getMembers() {
		ws?.send(JSON.stringify({ event: 'get-members', payload: { channel: 'room' } }));
	}
	function kick(tag: string, reason: string) {
		ws?.send(
			JSON.stringify({ event: 'kick-in-channel', payload: { channel: 'room', tag, reason } }),
		);
	}
	function sendRoom(text: string) {
		ws?.send(JSON.stringify({ event: 'send-room-message', payload: { text, _channel: 'room' } }));
	}
</script>

<h1>ctx-channels feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>
<button data-testid="get-members" onclick={getMembers}>Get members</button>
<button data-testid="kick-user2" onclick={() => kick('user2', 'Kicked by admin')}>
	Kick user2
</button>
<button data-testid="send-after-kick" onclick={() => sendRoom('after-kick')}>
	Send after-kick
</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="members-result">{membersResult}</span>
<span data-testid="kicked-result">{kickedResult}</span>
<span data-testid="room-messages">{roomMessages.join(',')}</span>
