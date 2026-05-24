<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let echoed = $state<string[]>([]);
	let lastErrorCode = $state('');

	// top-level nudge-stream state
	let nudgeChunks = $state<string[]>([]);
	let nudgeStreamEnd = $state(false);
	let nudgeStreamId = $state('');
	let sendHintOnStarted = $state(false);
	let sendBlockHintOnStarted = $state(false);

	// namespace ns-nudge-stream state
	let nsNudgeChunks = $state<string[]>([]);
	let nsNudgeStreamEnd = $state(false);
	let nsNudgeStreamId = $state('');
	let sendNsHintOnStarted = $state(false);
	let sendNsHintBlockOnStarted = $state(false);

	// channel ch-nudge-stream state
	let chNudgeChunks = $state<string[]>([]);
	let chNudgeStreamEnd = $state(false);
	let chNudgeStreamId = $state('');
	let sendChHintOnStarted = $state(false);
	let sendChHintBlockOnStarted = $state(false);

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
			if (data.event === '__subscribeOk__') subscribed = true;
			if (data.event === 'echoed') echoed = [...echoed, data.payload?.text ?? ''];
			if (data.event === '__error__') lastErrorCode = data.payload?.code ?? '';
			if (data.event === '__streamOk__' && data.__wskit?.streamId) {
				const sid = data.__wskit.streamId as string;
				if (data.__wskit.namespace === 'ns') nsNudgeStreamId = sid;
				else if (data.__wskit.channel === 'room') chNudgeStreamId = sid;
				else nudgeStreamId = sid;
			}
			if (data.event === 'nudge-stream') {
				const saw = data.payload?.saw ?? '';
				nudgeChunks = [...nudgeChunks, saw];
				if (saw === 'started' && nudgeStreamId) {
					if (sendHintOnStarted) {
						sendHintOnStarted = false;
						ws?.send(
							JSON.stringify({
								event: 'hint',
								payload: { text: 'hello' },
								__wskit: { streamId: nudgeStreamId },
							}),
						);
					}
					if (sendBlockHintOnStarted) {
						sendBlockHintOnStarted = false;
						ws?.send(
							JSON.stringify({
								event: 'hint',
								payload: { text: 'hint-block' },
								__wskit: { streamId: nudgeStreamId },
							}),
						);
					}
				}
			}
			if (data.event === 'ns-nudge-stream') {
				const saw = data.payload?.saw ?? '';
				nsNudgeChunks = [...nsNudgeChunks, saw];
				if (saw === 'started' && nsNudgeStreamId) {
					if (sendNsHintOnStarted) {
						sendNsHintOnStarted = false;
						ws?.send(
							JSON.stringify({
								event: 'ns-hint',
								payload: { text: 'hello' },
								__wskit: { streamId: nsNudgeStreamId, namespace: 'ns' },
							}),
						);
					}
					if (sendNsHintBlockOnStarted) {
						sendNsHintBlockOnStarted = false;
						ws?.send(
							JSON.stringify({
								event: 'ns-hint',
								payload: { text: 'ns-hint-block' },
								__wskit: { streamId: nsNudgeStreamId, namespace: 'ns' },
							}),
						);
					}
				}
			}
			if (data.event === 'ch-nudge-stream') {
				const saw = data.payload?.saw ?? '';
				chNudgeChunks = [...chNudgeChunks, saw];
				if (saw === 'started' && chNudgeStreamId) {
					if (sendChHintOnStarted) {
						sendChHintOnStarted = false;
						ws?.send(
							JSON.stringify({
								event: 'ch-hint',
								payload: { text: 'hello' },
								__wskit: { streamId: chNudgeStreamId, channel: 'room', channelScope: null },
							}),
						);
					}
					if (sendChHintBlockOnStarted) {
						sendChHintBlockOnStarted = false;
						ws?.send(
							JSON.stringify({
								event: 'ch-hint',
								payload: { text: 'ch-hint-block' },
								__wskit: { streamId: chNudgeStreamId, channel: 'room', channelScope: null },
							}),
						);
					}
				}
			}
			if (data.event === '__streamEnd__') {
				const endId = data.__wskit?.streamId as string;
				if (endId === nsNudgeStreamId) nsNudgeStreamEnd = true;
				else if (endId === chNudgeStreamId) chNudgeStreamEnd = true;
				else nudgeStreamEnd = true;
			}
		};
	}

	function send(text: string, scope?: 'ns' | 'room') {
		const payload: Record<string, unknown> = { text };
		let wskit: Record<string, unknown> | undefined;
		if (scope === 'ns') wskit = { namespace: 'ns' };
		if (scope === 'room') wskit = { channel: 'room' };
		ws?.send(
			JSON.stringify(wskit ? { event: 'echo', payload, __wskit: wskit } : { event: 'echo', payload }),
		);
	}
	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'room' } }));
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
	function startNsNudgeStream() {
		nsNudgeChunks = [];
		nsNudgeStreamEnd = false;
		nsNudgeStreamId = '';
		sendNsHintOnStarted = true;
		ws?.send(JSON.stringify({ event: 'ns-nudge-stream', payload: {}, __wskit: { namespace: 'ns' } }));
	}
	function startNsNudgeStreamBlock() {
		nsNudgeChunks = [];
		nsNudgeStreamEnd = false;
		nsNudgeStreamId = '';
		sendNsHintBlockOnStarted = true;
		ws?.send(JSON.stringify({ event: 'ns-nudge-stream', payload: {}, __wskit: { namespace: 'ns' } }));
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
				__wskit: { channel: 'room', channelScope: null },
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
				__wskit: { channel: 'room', channelScope: null },
			}),
		);
	}
</script>

<h1>intercept feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>

<button data-testid="send-top-pre" onclick={() => send('top-pre')}>Send top-pre</button>
<button data-testid="send-top-post" onclick={() => send('top-post')}>Send top-post</button>
<button data-testid="send-top-passthrough" onclick={() => send('top-passthrough')}>Send top-passthrough</button>
<button data-testid="send-top-post-passthrough" onclick={() => send('top-post-passthrough')}>Send top-post-passthrough</button>
<button data-testid="send-top-chain" onclick={() => send('top-chain')}>Send top-chain</button>
<button data-testid="send-top-post-block" onclick={() => send('top-post-block')}>Send top-post-block</button>
<button data-testid="send-ns-pre" onclick={() => send('ns-pre', 'ns')}>Send ns-pre</button>
<button data-testid="send-ns-post" onclick={() => send('ns-post', 'ns')}>Send ns-post</button>
<button data-testid="send-ns-pre-block" onclick={() => send('ns-pre-block', 'ns')}>Send ns-pre-block</button>
<button data-testid="send-ch-pre" onclick={() => send('ch-pre', 'room')}>Send ch-pre</button>
<button data-testid="send-ch-post" onclick={() => send('ch-post', 'room')}>Send ch-post</button>
<button data-testid="send-ch-pre-block" onclick={() => send('ch-pre-block', 'room')}>Send ch-pre-block</button>
<button data-testid="start-nudge-stream" onclick={startNudgeStream}>Start nudge stream</button>
<button data-testid="start-nudge-stream-block" onclick={startNudgeStreamBlock}>Start nudge stream (block)</button>
<button data-testid="start-ns-nudge-stream" onclick={startNsNudgeStream}>Start ns nudge stream</button>
<button data-testid="start-ns-nudge-stream-block" onclick={startNsNudgeStreamBlock}>Start ns nudge stream (block)</button>
<button data-testid="start-ch-nudge-stream" onclick={startChNudgeStream}>Start ch nudge stream</button>
<button data-testid="start-ch-nudge-stream-block" onclick={startChNudgeStreamBlock}>Start ch nudge stream (block)</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="echoed">{echoed.join(',')}</span>
<span data-testid="last-error-code">{lastErrorCode}</span>
<span data-testid="nudge-chunks">{nudgeChunks.join(',')}</span>
<span data-testid="nudge-stream-end">{nudgeStreamEnd ? 'yes' : 'no'}</span>
<span data-testid="ns-nudge-chunks">{nsNudgeChunks.join(',')}</span>
<span data-testid="ns-nudge-stream-end">{nsNudgeStreamEnd ? 'yes' : 'no'}</span>
<span data-testid="ch-nudge-chunks">{chNudgeChunks.join(',')}</span>
<span data-testid="ch-nudge-stream-end">{chNudgeStreamEnd ? 'yes' : 'no'}</span>
