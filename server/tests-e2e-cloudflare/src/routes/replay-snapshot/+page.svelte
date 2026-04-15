<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	let snapshots = $state<string[]>([]);
	let lastSeq = $state(0);
	let replayCount = $state(0);
	let replayRequested = $state(false);

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
</main>

<style>
	main { font-family: monospace; padding: 1rem; max-width: 800px; }
	section { margin: 1rem 0; padding: 0.5rem; border: 1px solid #ccc; }
	h2 { margin: 0 0 0.5rem; font-size: 1rem; }
</style>
