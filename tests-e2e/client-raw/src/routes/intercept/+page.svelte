<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let dynamicSubscribed = $state(false);
	let echoed = $state<string[]>([]);
	let lastErrorCode = $state('');

	// top-level nudge-stream state
	let nudgeChunks = $state<string[]>([]);
	let nudgeStreamEnd = $state(false);
	let nudgeStreamId = $state('');
	let sendHintOnStarted = $state(false);
	let sendBlockHintOnStarted = $state(false);

	// channel ch-nudge-stream state
	let chNudgeChunks = $state<string[]>([]);
	let chNudgeStreamEnd = $state(false);
	let chNudgeStreamId = $state('');
	let sendChHintOnStarted = $state(false);
	let sendChHintBlockOnStarted = $state(false);

	function sendNudge(event: string, text: string, metadata: Record<string, Record<string, unknown>>) {
		ws?.send(window.__livethingEncode({ event, payload: { text }, metadata }));
	}

	function handleTopNudge(payload: Record<string, any>) {
		const saw = payload.saw ?? '';
		nudgeChunks = [...nudgeChunks, saw];
		if (saw !== 'started' || !nudgeStreamId) return;

		if (sendHintOnStarted) {
			sendHintOnStarted = false;
			sendNudge('hint', 'hello', { stream: { id: nudgeStreamId } });
		}

		if (sendBlockHintOnStarted) {
			sendBlockHintOnStarted = false;
			sendNudge('hint', 'hint-block', { stream: { id: nudgeStreamId } });
		}
	}

	function handleChannelNudge(payload: Record<string, any>) {
		const saw = payload.saw ?? '';
		chNudgeChunks = [...chNudgeChunks, saw];
		if (saw !== 'started' || !chNudgeStreamId) return;

		const metadata = {
			stream: { id: chNudgeStreamId },
			channel: { name: 'room' },
		};
		if (sendChHintOnStarted) {
			sendChHintOnStarted = false;
			sendNudge('ch-hint', 'hello', metadata);
		}

		if (sendChHintBlockOnStarted) {
			sendChHintBlockOnStarted = false;
			sendNudge('ch-hint', 'ch-hint-block', metadata);
		}
	}

	const eventHandlers: Record<string, (data: any) => void> = {
		'__subscribeOk__': (data) => {
			if (data.metadata?.channel?.family === 'rooms') dynamicSubscribed = true;
			else subscribed = true;
		},
		echoed: (data) => (echoed = [...echoed, data.payload?.text ?? '']),
		'__error__': (data) => (lastErrorCode = data.payload?.code ?? ''),
		'__streamOk__': (data) => {
			const streamId = data.metadata?.stream?.id;
			if (!streamId) return;

			if (data.metadata.channel?.name === 'room') chNudgeStreamId = streamId;
			else nudgeStreamId = streamId;
		},
		'nudge-stream': (data) => handleTopNudge(data.payload ?? {}),
		'ch-nudge-stream': (data) => handleChannelNudge(data.payload ?? {}),
		'__streamEnd__': (data) => {
			if (data.metadata?.stream?.id === chNudgeStreamId) chNudgeStreamEnd = true;
			else nudgeStreamEnd = true;
		},
	};

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/intercept?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			const data = window.__livethingDecode(ev.data);
			eventHandlers[data.event]?.(data);
		};
	}

	function send(text: string, scope?: 'room' | 'dyn-room') {
		const payload: Record<string, unknown> = { text };
		let metadata: Record<string, Record<string, unknown>> | null = null;
		if (scope === 'room') metadata = { channel: { name: 'room' } };
		if (scope === 'dyn-room') metadata = { channel: { name: 'room:dyn', family: 'rooms' } };
		ws?.send(
			window.__livethingEncode({ event: 'echo', payload, metadata }),
		);
	}

	function subscribeRoom() {
		ws?.send(window.__livethingEncode({ event: '__subscribe__', payload: null, metadata: { channel: { name: 'room' } } }));
	}

	function subscribeDynamicRoom() {
		ws?.send(
			window.__livethingEncode({
				event: '__subscribe__',
				payload: null,
				metadata: { channel: { name: 'room:dyn', family: 'rooms' } },
			}),
		);
	}

	function startNudgeStream() {
		nudgeChunks = [];
		nudgeStreamEnd = false;
		nudgeStreamId = '';
		sendHintOnStarted = true;
		ws?.send(window.__livethingEncode({ event: 'nudge-stream', payload: {} }));
	}

	function startNudgeStreamBlock() {
		nudgeChunks = [];
		nudgeStreamEnd = false;
		nudgeStreamId = '';
		sendBlockHintOnStarted = true;
		ws?.send(window.__livethingEncode({ event: 'nudge-stream', payload: {} }));
	}

	function startChNudgeStream() {
		chNudgeChunks = [];
		chNudgeStreamEnd = false;
		chNudgeStreamId = '';
		sendChHintOnStarted = true;
		ws?.send(
			window.__livethingEncode({
				event: 'ch-nudge-stream',
				payload: {},
				metadata: { channel: { name: 'room' } },
			}),
		);
	}

	function startChNudgeStreamBlock() {
		chNudgeChunks = [];
		chNudgeStreamEnd = false;
		chNudgeStreamId = '';
		sendChHintBlockOnStarted = true;
		ws?.send(
			window.__livethingEncode({
				event: 'ch-nudge-stream',
				payload: {},
				metadata: { channel: { name: 'room' } },
			}),
		);
	}
</script>

<h1>intercept feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>
<button data-testid="subscribe-dynamic-room" onclick={subscribeDynamicRoom}>Subscribe dynamic room</button>

<button data-testid="send-top-pre" onclick={() => send('top-pre')}>Send top-pre</button>
<button data-testid="send-top-passthrough" onclick={() => send('top-passthrough')}>Send top-passthrough</button>
<button data-testid="send-ch-pre" onclick={() => send('ch-pre', 'room')}>Send ch-pre</button>
<button data-testid="send-ch-pre-block" onclick={() => send('ch-pre-block', 'room')}>Send ch-pre-block</button>
<button data-testid="send-dyn-pre" onclick={() => send('dyn-pre', 'dyn-room')}>Send dyn-pre</button>
<button data-testid="send-dyn-pre-block" onclick={() => send('dyn-pre-block', 'dyn-room')}>Send dyn-pre-block</button>
<button data-testid="start-nudge-stream" onclick={startNudgeStream}>Start nudge stream</button>
<button data-testid="start-nudge-stream-block" onclick={startNudgeStreamBlock}>Start nudge stream (block)</button>
<button data-testid="start-ch-nudge-stream" onclick={startChNudgeStream}>Start ch nudge stream</button>
<button data-testid="start-ch-nudge-stream-block" onclick={startChNudgeStreamBlock}>Start ch nudge stream (block)</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="dynamic-subscribed">{dynamicSubscribed ? 'yes' : 'no'}</span>
<span data-testid="echoed">{echoed.join(',')}</span>
<span data-testid="last-error-code">{lastErrorCode}</span>
<span data-testid="nudge-chunks">{nudgeChunks.join(',')}</span>
<span data-testid="nudge-stream-end">{nudgeStreamEnd ? 'yes' : 'no'}</span>
<span data-testid="ch-nudge-chunks">{chNudgeChunks.join(',')}</span>
<span data-testid="ch-nudge-stream-end">{chNudgeStreamEnd ? 'yes' : 'no'}</span>
