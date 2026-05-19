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

	function connect() {
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		const sock = new WebSocket(
			`${protocol}//${location.host}/ws/durable-stream?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

<h1>durable-stream feature</h1>
<input data-testid="username" bind:value={username} />
<input data-testid="stream-id" bind:value={streamIdInput} />
<input data-testid="since" bind:value={sinceInput} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="start-count-tokens" onclick={startCountTokens}>Start count-tokens</button>
<button data-testid="start-paginate" onclick={startPaginate}>Start paginate</button>
<button data-testid="drop-socket" onclick={dropSocket}>Drop socket</button>
<button data-testid="send-resume" onclick={sendResume}>Send resume</button>

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
