<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');

	let messages = $state<string[]>([]);
	let lastSeq = $state(0);
	let replayCount = $state(0);
	let replayRequested = $state(false);
	let rawLog = $state<string[]>([]);

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
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function sendMsg(text: string) {
		ws?.send(JSON.stringify({ event: 'send-msg', payload: { text } }));
	}

	function requestReplay() {
		replayCount = 0;
		replayRequested = true;
		ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
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
		<div data-testid="messages">{messages.join(' | ')}</div>
		<div data-testid="last-seq">{lastSeq}</div>
	</section>

	<section>
		<h2>Replay</h2>
		<button data-testid="replay-btn" onclick={requestReplay} disabled={status !== 'connected'}>Request Replay</button>
		<div data-testid="replay-count">{replayCount}</div>
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
