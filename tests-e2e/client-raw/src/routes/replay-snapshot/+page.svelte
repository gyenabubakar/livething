<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	let snapshots = $state<string[]>([]);
	let lastSeq = $state(0);
	let replayCount = $state(0);
	let replayRequested = $state(false);

	let counterSnapshots = $state<string[]>([]);
	let counterReplayCount = $state(0);
	let burstDoneCount = $state(0);
	let burstDoneSent = $state(0);
	let ageTestResult = $state('');
	let roomSubscribed = $state('');
	let roomSnapshots = $state<string[]>([]);
	let roomReplayCount = $state(0);

	function connect() {
		if (ws) return;

		status = 'connecting';
		replayRequested = false;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';

		ws = new WebSocket(
			`${protocol}//${location.host}/ws/replay-snapshot?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			if (evt === 'doc-snapshot') {
				const entry = `${payload.docId}:${payload.title}`;
				if (replayRequested) {
					replayCount++;
					snapshots = [...snapshots, entry];
				}
			} else if (evt === 'counter-snapshot') {
				const entry = `${payload.key}:${payload.total}`;
				if (replayRequested) {
					counterReplayCount++;
					counterSnapshots = [...counterSnapshots, entry];
				}
			} else if (evt === 'burst-done') {
				burstDoneCount += 1;
				burstDoneSent = payload.sent as number;
			} else if (evt === 'room-doc-snapshot') {
				const entry = `${payload.docId}:${payload.title}`;
				if (replayRequested) {
					roomReplayCount++;
					roomSnapshots = [...roomSnapshots, entry];
				}
			} else if (evt === '__subscribeOk__') {
				if (metadata?.channel?.name === 'snapshot-room') roomSubscribed = 'subscribed';
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function send(
		event: string,
		payload: Record<string, unknown> | null,
		metadata?: Record<string, Record<string, unknown>>,
	) {
		ws?.send(window.__livethingEncode(metadata ? { event, payload, metadata } : { event, payload }));
	}

	function updateDoc(docId: string, title: string) {
		send('update-doc', { docId, title });
	}

	function deleteDoc(docId: string) {
		send('delete-doc', { docId });
	}

	function floodMessages() {
		for (let i = 1; i <= 8; i++) {
			send('update-doc', { docId: `doc-${i}`, title: `title-${i}` });
		}
	}

	function requestReplay() {
		replayCount = 0;
		snapshots = [];
		replayRequested = true;
		ws?.send(window.__livethingEncode({ event: '__replay__', payload: { lastKnownSeq: 0 }, metadata: null }));
	}

	function incrementCounter(key: string, amount: number) {
		send('increment-counter', { key, amount });
	}

	function burstCounter(key: string, count: number) {
		send('burst-counter', { key, count });
	}

	function requestReplayForCounters() {
		counterReplayCount = 0;
		counterSnapshots = [];
		replayRequested = true;
		ws?.send(window.__livethingEncode({ event: '__replay__', payload: { lastKnownSeq: 0 }, metadata: null }));
	}

	function testMaxAge() {
		ageTestResult = '';
		send('update-doc', { docId: 'age-test', title: 'old-message' });
	}

	function joinRoom() {
		send('__subscribe__', null, { channel: { name: 'snapshot-room' } });
	}

	function updateRoomDoc(docId: string, title: string) {
		send('update-room-doc', { docId, title }, { channel: { name: 'snapshot-room' } });
	}

	function requestRoomReplay() {
		roomReplayCount = 0;
		roomSnapshots = [];
		replayRequested = true;
		ws?.send(
			window.__livethingEncode({
				event: '__replay__',
				payload: { lastKnownSeq: 0 },
				metadata: { channel: { name: 'snapshot-room' } },
			}),
		);
	}
</script>

<main>
	<h1>LiveThing replay-snapshot E2E</h1>

	<section>
		<h2>Connection</h2>
		<input data-testid="username-input" bind:value={username} placeholder="username" />
		<button data-testid="connect-btn" onclick={connect} disabled={status !== 'disconnected'}>Connect</button>
		<button data-testid="disconnect-btn" onclick={disconnect} disabled={status !== 'connected'}>Disconnect</button>
		<span data-testid="status">{status}</span>
	</section>

	<section>
		<h2>Documents</h2>
		<button data-testid="update-doc-a-btn" onclick={() => updateDoc('A', 'first-title')} disabled={status !== 'connected'}>Update Doc A (first)</button>
		<button data-testid="update-doc-a2-btn" onclick={() => updateDoc('A', 'second-title')} disabled={status !== 'connected'}>Update Doc A (second)</button>
		<button data-testid="update-doc-b-btn" onclick={() => updateDoc('B', 'doc-b-title')} disabled={status !== 'connected'}>Update Doc B</button>
		<button data-testid="delete-doc-a-btn" onclick={() => deleteDoc('A')} disabled={status !== 'connected'}>Delete Doc A</button>
		<button data-testid="flood-btn" onclick={floodMessages} disabled={status !== 'connected'}>Flood 8 Docs</button>
		<div data-testid="last-seq">{lastSeq}</div>
	</section>

	<section>
		<h2>Replay</h2>
		<button data-testid="replay-btn" onclick={requestReplay} disabled={status !== 'connected'}>Request Replay</button>
		<div data-testid="replay-count">{replayCount}</div>
		<div data-testid="snapshots">{snapshots.join(' | ')}</div>
	</section>

	<section>
		<h2>Reduce (Counter)</h2>
		<button data-testid="increment-counter-btn" onclick={() => incrementCounter('hits', 5)} disabled={status !== 'connected'}>Increment +5</button>
		<button data-testid="increment-counter-btn2" onclick={() => incrementCounter('hits', 3)} disabled={status !== 'connected'}>Increment +3</button>
		<button data-testid="counter-replay-btn" onclick={requestReplayForCounters} disabled={status !== 'connected'}>Replay Counters</button>
		<div data-testid="counter-snapshots">{counterSnapshots.join(' | ')}</div>
		<div data-testid="counter-replay-count">{counterReplayCount}</div>
	</section>

	<section>
		<h2>Burst (snapshot coalescing fixture)</h2>
		<button data-testid="burst-50-btn" onclick={() => burstCounter('burst', 50)} disabled={status !== 'connected'}>Burst 50</button>
		<div data-testid="burst-done-count">{burstDoneCount}</div>
		<div data-testid="burst-done-sent">{burstDoneSent}</div>
	</section>

	<section>
		<h2>maxAgeMs Test</h2>
		<button data-testid="age-test-btn" onclick={testMaxAge} disabled={status !== 'connected'}>Send Old Message</button>
		<div data-testid="age-test-result">{ageTestResult}</div>
	</section>

	<section>
		<h2>Channel Snapshot</h2>
		<button data-testid="room-join-btn" onclick={joinRoom} disabled={status !== 'connected'}>Join snapshot room</button>
		<button data-testid="room-update-doc-a-btn" onclick={() => updateRoomDoc('A', 'room-first')} disabled={roomSubscribed !== 'subscribed'}>Update Room Doc A (first)</button>
		<button data-testid="room-update-doc-a2-btn" onclick={() => updateRoomDoc('A', 'room-second')} disabled={roomSubscribed !== 'subscribed'}>Update Room Doc A (second)</button>
		<button data-testid="room-replay-btn" onclick={requestRoomReplay} disabled={roomSubscribed !== 'subscribed'}>Replay Room</button>
		<div data-testid="room-subscribed">{roomSubscribed}</div>
		<div data-testid="room-snapshots">{roomSnapshots.join(' | ')}</div>
		<div data-testid="room-replay-count">{roomReplayCount}</div>
	</section>
</main>

<style>
	main { font-family: monospace; padding: 1rem; max-width: 800px; }
	section { margin: 1rem 0; padding: 0.5rem; border: 1px solid #ccc; }
	h2 { margin: 0 0 0.5rem; font-size: 1rem; }
</style>
