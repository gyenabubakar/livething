<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	let messages = $state<string[]>([]);
	let lastSeq = $state(0);
	let replayCount = $state(0);
	let replayRequested = $state(false);
	let rawLog = $state<string[]>([]);
	let sinceValue = $state(0);
	let cursorEvents = $state<string[]>([]);
	let historyInjected = $state('');

	let roomSubscribed = $state('');
	let roomMessages = $state<string[]>([]);
	let roomReplayCount = $state(0);

	function connect() {
		if (ws) return;
		status = 'connecting';
		replayRequested = false;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/replay?username=${encodeURIComponent(username)}`,
		);

		ws.onopen = () => {
			status = 'connected';
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onerror = () => {
			status = 'disconnected';
			ws = null;
		};

		ws.onmessage = (event) => {
			if (event.data === 'pong') return;
			rawLog = [...rawLog, String(event.data)].slice(-30);
			const msg = JSON.parse(event.data as string) as {
				event: string;
				payload: Record<string, unknown>;
			};
			const { event: evt, payload } = msg;

			if (payload?._seq) lastSeq = payload._seq as number;

			if (evt === 'chat-msg') {
				const text = `${payload.from}: ${payload.text}`;
				messages = [...messages, text].slice(-50);
				if (replayRequested) replayCount++;
				if (payload.text === 'injected-history') historyInjected = 'true';
			} else if (evt === 'cursor') {
				cursorEvents = [...cursorEvents, `${payload.x},${payload.y}`].slice(-50);
			} else if (evt === 'room-msg') {
				const text = `${payload.from}: ${payload.text}`;
				roomMessages = [...roomMessages, text].slice(-50);
				if (replayRequested) roomReplayCount++;
			} else if (evt === '_subscribeOk') {
				if (payload._channel === 'replay-room') roomSubscribed = 'subscribed';
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function send(event: string, payload: Record<string, unknown>) {
		ws?.send(JSON.stringify({ event, payload }));
	}

	function sendMsg(text: string) {
		send('send-msg', { text });
	}

	function sendCursor(x: number, y: number) {
		send('send-cursor', { x, y });
	}

	function requestReplay() {
		replayCount = 0;
		roomReplayCount = 0;
		replayRequested = true;
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: sinceValue } }));
	}

	function joinRoom() {
		send('_subscribe', { _channel: 'replay-room' });
	}

	function sendRoomMsg(text: string) {
		send('send-room-msg', { text, _channel: 'replay-room' });
	}

	function requestRoomReplay() {
		roomReplayCount = 0;
		replayRequested = true;
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0, _channel: 'replay-room' } }));
	}

	function requestHistory() {
		historyInjected = '';
		send('request-history', {});
	}
</script>

<main>
	<h1>wskit replay e2e</h1>

	<section>
		<h2>Connection</h2>
		<input data-testid="username-input" bind:value={username} placeholder="username" />
		<button data-testid="connect-btn" onclick={connect} disabled={status !== 'disconnected'}>Connect</button>
		<button data-testid="disconnect-btn" onclick={disconnect} disabled={status !== 'connected'}>Disconnect</button>
		<span data-testid="status">{status}</span>
	</section>

	<section>
		<h2>Chat</h2>
		<button data-testid="send-msg-btn" onclick={() => sendMsg('hello from replay')} disabled={status !== 'connected'}>Send Message</button>
		<button data-testid="send-cursor-btn" onclick={() => sendCursor(100, 200)} disabled={status !== 'connected'}>Send Cursor</button>
		<div data-testid="messages">{messages.join(' | ')}</div>
		<div data-testid="cursor-events">{cursorEvents.join(' | ')}</div>
		<div data-testid="last-seq">{lastSeq}</div>
	</section>

	<section>
		<h2>Replay</h2>
		<input data-testid="since-input" type="number" bind:value={sinceValue} />
		<button data-testid="replay-btn" onclick={requestReplay} disabled={status !== 'connected'}>Request Replay</button>
		<div data-testid="replay-count">{replayCount}</div>
	</section>

	<section>
		<h2>Replay Room (Channel)</h2>
		<button data-testid="room-join-btn" onclick={joinRoom} disabled={status !== 'connected'}>Join Room</button>
		<button data-testid="room-send-btn" onclick={() => sendRoomMsg('room hello')} disabled={status !== 'connected'}>Send Room Msg</button>
		<button data-testid="room-replay-btn" onclick={requestRoomReplay} disabled={status !== 'connected'}>Replay Room</button>
		<div data-testid="room-subscribed">{roomSubscribed}</div>
		<div data-testid="room-messages">{roomMessages.join(' | ')}</div>
		<div data-testid="room-replay-count">{roomReplayCount}</div>
	</section>

	<section>
		<h2>Programmatic sendReplay</h2>
		<button data-testid="request-history-btn" onclick={requestHistory} disabled={status !== 'connected'}>Request History</button>
		<div data-testid="history-injected">{historyInjected}</div>
	</section>

	<section>
		<h2>Raw Log</h2>
		<div data-testid="raw-log">{rawLog.join('\n')}</div>
	</section>
</main>

<style>
	main { font-family: monospace; padding: 1rem; max-width: 800px; }
	section { margin: 1rem 0; padding: 0.5rem; border: 1px solid #ccc; }
	h2 { margin: 0 0 0.5rem; font-size: 1rem; }
</style>
