<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let roomMessages = $state<string[]>([]);
	let savedNotes = $state<Array<{ title: string; body: string }>>([]);
	let tags = $state<string[]>([]);
	let taggedMessages = $state<string[]>([]);
	let slowStreamId = $state('');
	let slowStreamOk = $state(false);
	let slowStreamError = $state('');
	let slowStreamChunks = $state<number[]>([]);
	let roomMembersCount = $state(-1);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/hibernation?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '__subscribeOk__') subscribed = true;
			if (data.event === 'room-message') roomMessages = [...roomMessages, data.payload.text];
			if (data.event === 'notes-list') savedNotes = data.payload.notes;
			if (data.event === 'tag-result') tags = data.payload.tags;
			if (data.event === 'tagged-message') {
				taggedMessages = [...taggedMessages, `${data.payload.from}:${data.payload.text}`];
			}
			if (data.event === '__streamOk__' && data.__wskit?.streamId) {
				slowStreamId = data.__wskit.streamId;
				slowStreamOk = true;
			}
			if (data.event === 'start-slow-stream' && typeof data.payload?.index === 'number') {
				slowStreamChunks = [...slowStreamChunks, data.payload.index];
			}
			if (data.event === '__error__' && data.__wskit?.streamId) {
				slowStreamError = `${data.payload.code}:${data.__wskit.streamId}`;
			}
			if (data.event === 'room-members-count') {
				roomMembersCount = data.payload.count;
			}
		};
	}

	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'room' } }));
	}

	function broadcastRoom(text: string) {
		ws?.send(
			JSON.stringify({ event: 'broadcast-to-room', payload: { text }, __wskit: { channel: 'room' } }),
		);
	}

	function saveNote(title: string, body: string) {
		ws?.send(JSON.stringify({ event: 'save-note', payload: { title, body } }));
	}

	function getNotes() {
		ws?.send(JSON.stringify({ event: 'get-notes', payload: {} }));
	}

	function tagSelf(tag: string) {
		ws?.send(JSON.stringify({ event: 'tag-self', payload: { tag } }));
	}

	function sendToTag(tag: string, text: string) {
		ws?.send(JSON.stringify({ event: 'send-to-tag', payload: { tag, text } }));
	}

	function startSlowStream() {
		slowStreamId = '';
		slowStreamOk = false;
		slowStreamError = '';
		slowStreamChunks = [];
		ws?.send(JSON.stringify({ event: 'start-slow-stream', payload: {} }));
	}

	function wakeWithPing() {
		ws?.send(JSON.stringify({ event: 'get-notes', payload: {} }));
	}

	function getRoomMembers() {
		ws?.send(JSON.stringify({ event: 'get-room-members', payload: {} }));
	}
</script>

<h1>hibernation feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>
<button data-testid="broadcast-hello" onclick={() => broadcastRoom('hello-after-wake')}>
	Broadcast hello
</button>
<button data-testid="save-note" onclick={() => saveNote('test-note', 'test-content')}>
	Save note
</button>
<button data-testid="get-notes" onclick={getNotes}>
	Get notes
</button>
<button data-testid="tag-sleeper" onclick={() => tagSelf('sleeper')}>
	Tag as sleeper
</button>
<button data-testid="send-to-sleepers" onclick={() => sendToTag('sleeper', 'hello-sleeper-after-wake')}>
	SendTo sleepers
</button>
<button data-testid="start-slow-stream" onclick={startSlowStream}>Start slow stream</button>
<button data-testid="wake-with-ping" onclick={wakeWithPing}>Wake with ping</button>
<button data-testid="get-room-members" onclick={getRoomMembers}>Get room members</button>
<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="room-messages">{roomMessages.join(',')}</span>
<span data-testid="saved-notes">{savedNotes.map(n => `${n.title}:${n.body}`).join('|')}</span>
<span data-testid="tags">{tags.join(',')}</span>
<span data-testid="tagged-messages">{taggedMessages.join(',')}</span>
<span data-testid="slow-stream-ok">{slowStreamOk ? 'yes' : 'no'}</span>
<span data-testid="slow-stream-id">{slowStreamId}</span>
<span data-testid="slow-stream-error">{slowStreamError}</span>
<span data-testid="slow-stream-chunks">{slowStreamChunks.join(',')}</span>
<span data-testid="room-members-count">{roomMembersCount}</span>
