<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	let notes = $state<string[]>([]);
	let lastSeq = $state(0);
	let replayCount = $state(0);
	let replayRequested = $state(false);
	let confirmedResult = $state('');
	let sinceValue = $state(0);
	let roomNotes = $state<string[]>([]);
	let roomSubscribed = $state('');
	let roomReplayCount = $state(0);
	let roomConfirmedResult = $state('');
	let roomSinceValue = $state(0);
	let badReplayUndeclared = $state('');

	function connect() {
		if (ws) return;

		status = 'connecting';
		replayRequested = false;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';

		ws = new WebSocket(
			`${protocol}//${location.host}/ws/replay-custom?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		ws.onopen = () => {
			status = 'connected';
			(window as unknown as Record<string, unknown>).__ws = ws;
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

			const msg = window.__livethingDecode(event.data) as {
				event: string;
				payload: Record<string, unknown>;
				metadata?: Record<string, Record<string, unknown>> | null;
			};
			const { event: evt, payload, metadata } = msg;

			if (metadata?.delivery?.seq) lastSeq = metadata.delivery?.seq as number;

			if (evt === 'note') {
				notes = [...notes, `${payload.author}: ${payload.text}`].slice(-50);
				if (replayRequested) replayCount++;
			} else if (evt === 'confirmed-count') {
				confirmedResult = `total:${payload.total},confirmed:${payload.confirmed}`;
			} else if (evt === 'room-note') {
				roomNotes = [...roomNotes, `${payload.author}: ${payload.text}`].slice(-50);
				if (replayRequested) roomReplayCount++;
			} else if (evt === 'room-confirmed-count') {
				roomConfirmedResult = `total:${payload.total},confirmed:${payload.confirmed}`;
			} else if (evt === 'bad-replay-log') {
				badReplayUndeclared = String(payload.undeclared ?? '');
			} else if (evt === '__subscribeOk__') {
				if (metadata?.channel?.name === 'custom-room') roomSubscribed = 'subscribed';
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function addNote(text: string) {
		ws?.send(window.__livethingEncode({ event: 'add-note', payload: { text } }));
	}

	function requestReplay() {
		replayCount = 0;
		replayRequested = true;
		ws?.send(
			window.__livethingEncode({ event: '__replay__', payload: { lastKnownSeq: sinceValue }, metadata: null }),
		);
	}

	function getConfirmedCount() {
		ws?.send(window.__livethingEncode({ event: 'get-confirmed-count', payload: {} }));
	}

	function joinRoom() {
		ws?.send(
			window.__livethingEncode({ event: '__subscribe__', payload: null, metadata: { channel: { name: 'custom-room' } } }),
		);
	}

	function addRoomNote(text: string) {
		ws?.send(
			window.__livethingEncode({
				event: 'add-room-note',
				payload: { text },
				metadata: { channel: { name: 'custom-room' } },
			}),
		);
	}

	function requestRoomReplay() {
		roomReplayCount = 0;
		replayRequested = true;
		ws?.send(
			window.__livethingEncode({
				event: '__replay__',
				payload: { lastKnownSeq: roomSinceValue },
				metadata: { channel: { name: 'custom-room' } },
			}),
		);
	}

	function getRoomConfirmedCount() {
		roomConfirmedResult = '';
		ws?.send(
			window.__livethingEncode({
				event: 'get-room-confirmed-count',
				payload: {},
				metadata: { channel: { name: 'custom-room' } },
			}),
		);
	}

	function triggerBadReplay() {
		badReplayUndeclared = '';
		ws?.send(
			window.__livethingEncode({ event: '__replay__', payload: { lastKnownSeq: 2_147_483_647 }, metadata: null }),
		);
	}

	function queryBadReplayLog() {
		ws?.send(window.__livethingEncode({ event: 'query-bad-replay-log', payload: {} }));
	}
</script>

<main>
	<h1>LiveThing custom replay E2E</h1>

	<section>
		<h2>Connection</h2>
		<input data-testid="username-input" bind:value={username} placeholder="username" />
		<button data-testid="connect-btn" onclick={connect} disabled={status !== 'disconnected'}>Connect</button>
		<button data-testid="disconnect-btn" onclick={disconnect} disabled={status !== 'connected'}>Disconnect</button>
		<span data-testid="status">{status}</span>
	</section>

	<section>
		<h2>Notes</h2>
		<button data-testid="add-note-btn" onclick={() => addNote('custom replay note')} disabled={status !== 'connected'}>Add Note</button>
		<div data-testid="notes">{notes.join(' | ')}</div>
		<div data-testid="last-seq">{lastSeq}</div>
	</section>

	<section>
		<h2>Replay</h2>
		<input data-testid="since-input" type="number" bind:value={sinceValue} />
		<button data-testid="replay-btn" onclick={requestReplay} disabled={status !== 'connected'}>Request Replay</button>
		<button data-testid="confirmed-btn" onclick={getConfirmedCount} disabled={status !== 'connected'}>Get Confirmed</button>
		<div data-testid="replay-count">{replayCount}</div>
		<div data-testid="confirmed-result">{confirmedResult}</div>
	</section>

	<section>
		<h2>Custom Room (Channel)</h2>
		<button data-testid="room-join-btn" onclick={joinRoom} disabled={status !== 'connected'}>Join Room</button>
		<button data-testid="room-note-btn" onclick={() => addRoomNote('channel replay note')} disabled={status !== 'connected'}>Add Room Note</button>
		<input data-testid="room-since-input" type="number" bind:value={roomSinceValue} />
		<button data-testid="room-replay-btn" onclick={requestRoomReplay} disabled={status !== 'connected'}>Replay Room</button>
		<button data-testid="room-confirmed-btn" onclick={getRoomConfirmedCount} disabled={status !== 'connected'}>Get Room Confirmed</button>
		<div data-testid="room-subscribed">{roomSubscribed}</div>
		<div data-testid="room-notes">{roomNotes.join(' | ')}</div>
		<div data-testid="room-replay-count">{roomReplayCount}</div>
		<div data-testid="room-confirmed-result">{roomConfirmedResult}</div>
	</section>

	<section>
		<h2>Bad Replay Pin</h2>
		<button data-testid="trigger-bad-replay-btn" onclick={triggerBadReplay} disabled={status !== 'connected'}>Trigger Bad Replay</button>
		<button data-testid="query-bad-replay-btn" onclick={queryBadReplayLog} disabled={status !== 'connected'}>Query Bad Replay Log</button>
		<div data-testid="bad-replay-undeclared">{badReplayUndeclared}</div>
	</section>
</main>

<style>
	main { font-family: monospace; padding: 1rem; max-width: 800px; }
	section { margin: 1rem 0; padding: 0.5rem; border: 1px solid #ccc; }
	h2 { margin: 0 0 0.5rem; font-size: 1rem; }
</style>
