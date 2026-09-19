<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let subscribeOks = $state<string[]>([]);
	let subscribeErrors = $state<string[]>([]);
	let joinedMessages = $state<string[]>([]);

	function connect() {
		if (ws) return;

		status = 'connecting';
		const url = new URL(location.href);
		const username = url.searchParams.get('username') ?? 'testuser';
		const room = url.searchParams.get('room') ?? 'default';

		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(
			`${proto}//${location.host}/ws/channel-check-commit?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => (status = 'connected');
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;

			const msg = window.__livethingDecode(ev.data);
			if (msg.event === '__subscribeOk__') {
				subscribeOks = [...subscribeOks, msg.metadata?.channel?.name ?? ''];
			}

			if (msg.event === '__error__' && msg.metadata?.channel?.name) {
				subscribeErrors = [...subscribeErrors, msg.metadata.channel?.name ?? ''];
			}

			if (msg.event === 'joined') {
				joinedMessages = [...joinedMessages, msg.payload?.username ?? ''];
			}
		};
	}

	function send(event: string, payload: unknown, metadata: Record<string, unknown>) {
		ws?.send(window.__livethingEncode({ event, payload, metadata }));
	}

	function subRoom(token: string) {
		send('__subscribe__', { token }, { channel: { name: 'room' } });
	}

	function subRoomNoToken() {
		send('__subscribe__', null, { channel: { name: 'room' } });
	}

	function subRoomBadToken() {
		send('__subscribe__', { token: 42 }, { channel: { name: 'room' } });
	}

	function subCheckOnly() {
		send('__subscribe__', null, { channel: { name: 'check-only' } });
	}

	function subCommitOnly() {
		send('__subscribe__', null, { channel: { name: 'commit-only' } });
	}
</script>

<button data-testid="connect" onclick={connect}>Connect</button>
<span data-testid="status">{status}</span>

<button data-testid="sub-room-member" onclick={() => subRoom('tok-member')}>room (member)</button>
<button data-testid="sub-room-vip" onclick={() => subRoom('tok-vip')}>room (vip)</button>
<button data-testid="sub-room-banned" onclick={() => subRoom('tok-banned')}>room (banned)</button>
<button data-testid="sub-room-unknown" onclick={() => subRoom('tok-unknown')}>room (unknown)</button>
<button data-testid="sub-room-no-token" onclick={subRoomNoToken}>room (no token)</button>
<button data-testid="sub-room-bad-token" onclick={subRoomBadToken}>room (bad token type)</button>
<button data-testid="sub-check-only" onclick={subCheckOnly}>check-only</button>
<button data-testid="sub-commit-only" onclick={subCommitOnly}>commit-only</button>

<span data-testid="subscribe-ok">{subscribeOks.join(',')}</span>
<span data-testid="subscribe-error">{subscribeErrors.join(',')}</span>
<span data-testid="joined">{joinedMessages.join(',')}</span>
