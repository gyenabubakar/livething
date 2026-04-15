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
	let ageTestResult = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		replayRequested = false;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/replay-snapshot?username=${encodeURIComponent(username)}`,
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
			const msg = JSON.parse(event.data as string) as {
				event: string;
				payload: Record<string, unknown>;
			};
			const { event: evt, payload } = msg;

			if (payload?._seq) lastSeq = payload._seq as number;

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
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function send(event: string, payload: Record<string, unknown>) {
		ws?.send(JSON.stringify({ event, payload }));
	}

	function updateDoc(docId: string, title: string) {
		send('update-doc', { docId, title });
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
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
	}

	function incrementCounter(key: string, amount: number) {
		send('increment-counter', { key, amount });
	}

	function requestReplayForCounters() {
		counterReplayCount = 0;
		counterSnapshots = [];
		replayRequested = true;
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
	}

	function testMaxAge() {
		ageTestResult = '';
		send('update-doc', { docId: 'age-test', title: 'old-message' });
	}
</script>

<main>
	<h1>wskit replay-snapshot e2e</h1>

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
		<h2>maxAgeMs Test</h2>
		<button data-testid="age-test-btn" onclick={testMaxAge} disabled={status !== 'connected'}>Send Old Message</button>
		<div data-testid="age-test-result">{ageTestResult}</div>
	</section>
</main>

<style>
	main { font-family: monospace; padding: 1rem; max-width: 800px; }
	section { margin: 1rem 0; padding: 0.5rem; border: 1px solid #ccc; }
	h2 { margin: 0 0 0.5rem; font-size: 1rem; }
</style>
