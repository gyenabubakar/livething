<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let indices = $state<number[]>([]);
	let streamEnd = $state(false);
	let roomIndices = $state<number[]>([]);
	let roomStreamEnd = $state(false);
	let roomScopeSeen = $state<string>('');
	let roomSubscribed = $state(false);

	function connect() {
		if (ws) return;
		status = 'connecting';
		indices = [];
		streamEnd = false;
		roomIndices = [];
		roomStreamEnd = false;
		roomScopeSeen = '';
		roomSubscribed = false;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-broadcast?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_subscribeOk' && data.payload?._channelScope === 'rooms') {
				roomSubscribed = true;
			}
			if (data.event === '_streamEnd') {
				if (data.payload?._channelScope === 'rooms') roomStreamEnd = true;
				else streamEnd = true;
			}
			if (data.event === 'start-broadcast' && typeof data.payload?.index === 'number') {
				indices = [...indices, data.payload.index];
			}
			if (data.event === 'start-room-broadcast' && typeof data.payload?.index === 'number') {
				roomIndices = [...roomIndices, data.payload.index];
				if (typeof data.payload?._channelScope === 'string') {
					roomScopeSeen = data.payload._channelScope;
				}
			}
		};
	}

	function start(count: number) {
		indices = [];
		streamEnd = false;
		ws?.send(JSON.stringify({ event: 'start-broadcast', payload: { count } }));
	}

	function joinRoom() {
		ws?.send(
			JSON.stringify({
				event: '_subscribe',
				payload: { _channel: 'room:42', _channelScope: 'rooms' },
			}),
		);
	}

	function startRoom(count: number) {
		roomIndices = [];
		roomStreamEnd = false;
		roomScopeSeen = '';
		ws?.send(
			JSON.stringify({
				event: 'start-room-broadcast',
				payload: { count, _channel: 'room:42', _channelScope: 'rooms' },
			}),
		);
	}
</script>

<h1>stream-broadcast feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="start-3" onclick={() => start(3)}>Start 3</button>
<button data-testid="join-room" onclick={joinRoom}>Join room</button>
<button data-testid="start-room-3" onclick={() => startRoom(3)}>Start room 3</button>
<span data-testid="status">{status}</span>
<span data-testid="indices">{indices.join(',')}</span>
<span data-testid="stream-end">{streamEnd ? 'yes' : 'no'}</span>
<span data-testid="room-indices">{roomIndices.join(',')}</span>
<span data-testid="room-stream-end">{roomStreamEnd ? 'yes' : 'no'}</span>
<span data-testid="room-scope-seen">{roomScopeSeen}</span>
<span data-testid="room-subscribed">{roomSubscribed ? 'yes' : 'no'}</span>
