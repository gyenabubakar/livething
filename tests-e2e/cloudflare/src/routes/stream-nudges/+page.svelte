<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastStreamId = $state('');
	let tokens = $state('');
	let streamEnd = $state(false);
	let pauseTopLevelLeak = $state('');
	let lastError = $state('');
	let lastErrorStreamId = $state('');
	let nudgeSawEvents = $state('');
	let autoPauseOnStreamOk = $state(false);

	function reset() {
		lastStreamId = '';
		tokens = '';
		streamEnd = false;
		pauseTopLevelLeak = '';
		lastError = '';
		lastErrorStreamId = '';
		nudgeSawEvents = '';
	}

	function connect() {
		if (ws) return;
		status = 'connecting';
		reset();
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-nudges?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			switch (data.event) {
				case '__streamOk__':
					if (data.__wskit?.streamId) lastStreamId = data.__wskit.streamId;
					if (autoPauseOnStreamOk && data.__wskit?.streamId) {
						autoPauseOnStreamOk = false;
						ws?.send(
							JSON.stringify({
								event: 'pause',
								payload: {},
								__wskit: { streamId: data.__wskit.streamId },
							}),
						);
					}
					break;
				case '__streamEnd__':
					streamEnd = true;
					break;
				case 'start-nudge-stream':
					if (typeof data.payload?.token === 'string') tokens += data.payload.token;
					break;
				case 'pause-top-level-fired':
					pauseTopLevelLeak = String(data.payload?.leak ?? '');
					break;
				case 'nudge-saw': {
					const events = Array.isArray(data.payload?.events) ? data.payload.events : [];
					// Append per iteration so the test can assert across multiple drains.
					nudgeSawEvents += (nudgeSawEvents ? '|' : '') + events.join(',');
					break;
				}
				case '__error__':
					lastError = String(data.payload?.code ?? '');
					lastErrorStreamId = String(data.__wskit?.streamId ?? '');
					break;
			}
		};
	}

	function start(prompt: string) {
		reset();
		ws?.send(JSON.stringify({ event: 'start-nudge-stream', payload: { prompt } }));
	}
	function pause() {
		ws?.send(JSON.stringify({ event: 'pause', payload: {}, __wskit: { streamId: lastStreamId } }));
	}
	function startThenPause() {
		reset();
		autoPauseOnStreamOk = true;
		ws?.send(
			JSON.stringify({
				event: 'start-nudge-stream',
				payload: { prompt: 'a b c d e f g h i j k l m n o p' },
			}),
		);
	}
	function pauseMultiple(count: number) {
		for (let i = 0; i < count; i++) {
			ws?.send(
				JSON.stringify({ event: 'pause', payload: {}, __wskit: { streamId: lastStreamId } }),
			);
		}
	}
	function speedUp(factor: number) {
		ws?.send(
			JSON.stringify({ event: 'speed-up', payload: { factor }, __wskit: { streamId: lastStreamId } }),
		);
	}
	function malformedPause() {
		ws?.send(
			JSON.stringify({
				event: 'pause',
				payload: { leak: 'should-not-reach-handler' },
				__wskit: { streamId: lastStreamId },
			}),
		);
	}
</script>

<h1>stream-nudges feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="start-short" onclick={() => start('one two three')}>Start short</button>
<button data-testid="start-long" onclick={() => start('a b c d e f g h i j k l m n o p')}>
	Start long
</button>
<button data-testid="pause" onclick={pause}>Pause</button>
<button data-testid="start-then-pause" onclick={startThenPause}>Start then pause</button>
<button data-testid="pause-multiple" onclick={() => pauseMultiple(3)}>Pause x3</button>
<button data-testid="speed-up" onclick={() => speedUp(50)}>Speed up x50</button>
<button data-testid="malformed-pause" onclick={malformedPause}>Malformed pause</button>

<span data-testid="status">{status}</span>
<span data-testid="stream-id">{lastStreamId}</span>
<span data-testid="tokens">{tokens}</span>
<span data-testid="stream-end">{streamEnd ? 'yes' : 'no'}</span>
<span data-testid="pause-top-level-leak">{pauseTopLevelLeak}</span>
<span data-testid="last-error">{lastError}</span>
<span data-testid="last-error-stream-id">{lastErrorStreamId}</span>
<span data-testid="nudge-saw-events">{nudgeSawEvents}</span>
