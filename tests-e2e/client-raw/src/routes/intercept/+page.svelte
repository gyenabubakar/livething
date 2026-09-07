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

	function sendNudge(event: string, text: string, wskit: Record<string, unknown>) {
		ws?.send(JSON.stringify({ event, payload: { text }, __wskit: wskit }));
	}

	function handleTopNudge(payload: Record<string, any>) {
		const saw = payload.saw ?? '';
		nudgeChunks = [...nudgeChunks, saw];
		if (saw !== 'started' || !nudgeStreamId) return;
		if (sendHintOnStarted) {
			sendHintOnStarted = false;
			sendNudge('hint', 'hello', { streamId: nudgeStreamId });
		}
		if (sendBlockHintOnStarted) {
			sendBlockHintOnStarted = false;
			sendNudge('hint', 'hint-block', { streamId: nudgeStreamId });
		}
	}

	function handleChannelNudge(payload: Record<string, any>) {
		const saw = payload.saw ?? '';
		chNudgeChunks = [...chNudgeChunks, saw];
		if (saw !== 'started' || !chNudgeStreamId) return;
		const wskit = { streamId: chNudgeStreamId, channel: 'room', channelFamily: null };
		if (sendChHintOnStarted) {
			sendChHintOnStarted = false;
			sendNudge('ch-hint', 'hello', wskit);
		}
		if (sendChHintBlockOnStarted) {
			sendChHintBlockOnStarted = false;
			sendNudge('ch-hint', 'ch-hint-block', wskit);
		}
	}

	const eventHandlers: Record<string, (data: any) => void> = {
		'__subscribeOk__': (data) => {
			if (data.__wskit?.channelFamily === 'rooms') dynamicSubscribed = true;
			else subscribed = true;
		},
		echoed: (data) => (echoed = [...echoed, data.payload?.text ?? '']),
		'__error__': (data) => (lastErrorCode = data.payload?.code ?? ''),
		'__streamOk__': (data) => {
			const streamId = data.__wskit?.streamId;
			if (!streamId) return;
			if (data.__wskit.channel === 'room') chNudgeStreamId = streamId;
			else nudgeStreamId = streamId;
		},
		'nudge-stream': (data) => handleTopNudge(data.payload ?? {}),
		'ch-nudge-stream': (data) => handleChannelNudge(data.payload ?? {}),
		'__streamEnd__': (data) => {
			if (data.__wskit?.streamId === chNudgeStreamId) chNudgeStreamEnd = true;
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
			const data = JSON.parse(ev.data);
			eventHandlers[data.event]?.(data);
		};
	}

	function send(text: string, scope?: 'room' | 'dyn-room') {
		const payload: Record<string, unknown> = { text };
		let wskit: Record<string, unknown> | undefined;
		if (scope === 'room') wskit = { channel: 'room' };
		if (scope === 'dyn-room') wskit = { channel: 'room:dyn', channelFamily: 'rooms' };
		ws?.send(
			JSON.stringify(wskit ? { event: 'echo', payload, __wskit: wskit } : { event: 'echo', payload }),
		);
	}
	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'room' } }));
	}
	function subscribeDynamicRoom() {
		ws?.send(
			JSON.stringify({
				event: '__subscribe__',
				payload: {},
				__wskit: { channel: 'room:dyn', channelFamily: 'rooms' },
			}),
		);
	}
	function startNudgeStream() {
		nudgeChunks = [];
		nudgeStreamEnd = false;
		nudgeStreamId = '';
		sendHintOnStarted = true;
		ws?.send(JSON.stringify({ event: 'nudge-stream', payload: {} }));
	}
	function startNudgeStreamBlock() {
		nudgeChunks = [];
		nudgeStreamEnd = false;
		nudgeStreamId = '';
		sendBlockHintOnStarted = true;
		ws?.send(JSON.stringify({ event: 'nudge-stream', payload: {} }));
	}
	function startChNudgeStream() {
		chNudgeChunks = [];
		chNudgeStreamEnd = false;
		chNudgeStreamId = '';
		sendChHintOnStarted = true;
		ws?.send(
			JSON.stringify({
				event: 'ch-nudge-stream',
				payload: {},
				__wskit: { channel: 'room', channelFamily: null },
			}),
		);
	}
	function startChNudgeStreamBlock() {
		chNudgeChunks = [];
		chNudgeStreamEnd = false;
		chNudgeStreamId = '';
		sendChHintBlockOnStarted = true;
		ws?.send(
			JSON.stringify({
				event: 'ch-nudge-stream',
				payload: {},
				__wskit: { channel: 'room', channelFamily: null },
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
