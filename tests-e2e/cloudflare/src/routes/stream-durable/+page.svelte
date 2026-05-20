<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('ds-user');
	let streamIdInput = $state('');
	let sinceInput = $state('0');
	let tokenChunks = $state<number[]>([]);
	let paginateRows = $state<number[]>([]);
	let lastErrorCode = $state<string | null>(null);
	let lastErrorReason = $state<string | null>(null);
	let lastErrorStreamId = $state<string | null>(null);
	let streamEndCount = $state(0);
	let allMsgCount = $state(0);
	let attemptValue = $state<number | null>(null);
	let bufferChunkCount = $state(0);

	function connect() {
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		const sock = new WebSocket(
			`${protocol}//${location.host}/ws/stream-durable?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		sock.onopen = () => {
			ws = sock;
			status = 'connected';
		};
		sock.onclose = () => {
			ws = null;
			status = 'disconnected';
		};
		sock.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			allMsgCount += 1;
			const data = JSON.parse(ev.data);
			if (data.event === 'count-tokens' && typeof data.payload?.idx === 'number') {
				tokenChunks = [...tokenChunks, data.payload.idx];
			} else if (data.event === 'paginate' && typeof data.payload?.row === 'number') {
				paginateRows = [...paginateRows, data.payload.row];
			} else if (data.event === 'attempt-stream' && typeof data.payload?.attempt === 'number') {
				attemptValue = data.payload.attempt;
			} else if (data.event === 'buffer-full-demo' && typeof data.payload?.n === 'number') {
				bufferChunkCount += 1;
			} else if (data.event === '_streamEnd') {
				streamEndCount += 1;
			} else if (data.event === '_error') {
				lastErrorCode = data.payload?.code ?? null;
				lastErrorReason = data.payload?.detail?.reason ?? null;
				lastErrorStreamId = data.payload?._streamId ?? null;
			}
		};
	}

	function send(event: string, payload: Record<string, unknown>) {
		ws?.send(JSON.stringify({ event, payload }));
	}

	function startCountTokens() {
		tokenChunks = [];
		streamEndCount = 0;
		send('count-tokens', { _streamId: streamIdInput });
	}

	function startPaginate() {
		paginateRows = [];
		streamEndCount = 0;
		send('paginate', { _streamId: streamIdInput });
	}

	function startAttemptStream() {
		attemptValue = null;
		streamEndCount = 0;
		send('attempt-stream', { _streamId: streamIdInput });
	}

	function startBufferFullDemo() {
		bufferChunkCount = 0;
		streamEndCount = 0;
		send('buffer-full-demo', { _streamId: streamIdInput });
	}

	function sendCancel() {
		send('_streamCancel', { _streamId: streamIdInput });
	}

	function dropSocket() {
		const sock = ws;
		ws = null;
		status = 'disconnected';
		// Best-effort close; we already cleared local state so the UI updates
		// immediately even if the server's close roundtrip is slow.
		try {
			sock?.close();
		} catch {
			// ignore
		}
	}

	function sendResume() {
		send('_resume', { _streamId: streamIdInput, since: Number(sinceInput) || 0 });
	}
</script>

<h1>stream-durable feature</h1>
<input data-testid="username" bind:value={username} />
<input data-testid="stream-id" bind:value={streamIdInput} />
<input data-testid="since" bind:value={sinceInput} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="start-count-tokens" onclick={startCountTokens}>Start count-tokens</button>
<button data-testid="start-paginate" onclick={startPaginate}>Start paginate</button>
<button data-testid="start-attempt" onclick={startAttemptStream}>Start attempt-stream</button>
<button data-testid="start-buffer-full" onclick={startBufferFullDemo}>Start buffer-full-demo</button>
<button data-testid="drop-socket" onclick={dropSocket}>Drop socket</button>
<button data-testid="send-resume" onclick={sendResume}>Send resume</button>
<button data-testid="send-cancel" onclick={sendCancel}>Cancel stream</button>

<span data-testid="status">{status}</span>
<span data-testid="token-chunks">{tokenChunks.join(',')}</span>
<span data-testid="token-chunk-count">{tokenChunks.length}</span>
<span data-testid="paginate-rows">{paginateRows.join(',')}</span>
<span data-testid="paginate-row-count">{paginateRows.length}</span>
<span data-testid="stream-end-count">{streamEndCount}</span>
<span data-testid="last-error-code">{lastErrorCode ?? ''}</span>
<span data-testid="last-error-reason">{lastErrorReason ?? ''}</span>
<span data-testid="last-error-stream-id">{lastErrorStreamId ?? ''}</span>
<span data-testid="all-msg-count">{allMsgCount}</span>
<span data-testid="attempt-value">{attemptValue ?? ''}</span>
<span data-testid="buffer-chunk-count">{bufferChunkCount}</span>
