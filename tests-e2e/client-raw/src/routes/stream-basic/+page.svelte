<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastStreamId = $state('');
	let streamOkReceived = $state(false);
	let chunkIndices = $state<number[]>([]);
	let streamError = $state('');
	let streamEnd = $state(false);
	let cancelObserved = $state(false);

	function reset() {
		lastStreamId = '';
		streamOkReceived = false;
		chunkIndices = [];
		streamError = '';
		streamEnd = false;

		cancelObserved = false;
	}

	function connect() {
		if (ws) return;

		status = 'connecting';
		reset();
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';

		ws = new WebSocket(
			`${protocol}//${location.host}/ws/stream-basic?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			switch (data.event) {
				case '__streamOk__':
					streamOkReceived = true;
					if (data.metadata?.stream?.id) lastStreamId = data.metadata.stream?.id;
					break;

				case '__streamEnd__':
					streamEnd = true;
					break;

				case '__error__':
					if (data.metadata?.stream?.id) {
						streamError = `stream-error:${data.payload.code}`;
					}

					break;

				case 'start-tokens':
				case 'start-boom':
				case 'start-boom-immediate':
				case 'start-typed-error':
				case 'start-cancel-observe':
					if (typeof data.payload?.index === 'number') {
						chunkIndices = [...chunkIndices, data.payload.index];
					}

					break;

				case 'cancel-observed':
					cancelObserved = true;
					break;
			}
		};
	}

	function startTokens(count: number) {
		reset();
		ws?.send(window.__livethingEncode({ event: 'start-tokens', payload: { count } }));
	}

	function startBoom() {
		reset();
		ws?.send(window.__livethingEncode({ event: 'start-boom', payload: {} }));
	}

	function startBoomImmediate() {
		reset();
		ws?.send(window.__livethingEncode({ event: 'start-boom-immediate', payload: {} }));
	}

	function startTypedError() {
		reset();
		ws?.send(window.__livethingEncode({ event: 'start-typed-error', payload: {} }));
	}

	function startCancelObserve() {
		reset();
		ws?.send(window.__livethingEncode({ event: 'start-cancel-observe', payload: {} }));
	}

	function startEmpty() {
		reset();
		ws?.send(window.__livethingEncode({ event: 'start-empty', payload: {} }));
	}

	function cancelStream() {
		ws?.send(
			window.__livethingEncode({ event: '__streamCancel__', payload: null, metadata: { stream: { id: lastStreamId } } }),
		);
	}
</script>

<h1>stream-basic feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="start-0" onclick={() => startEmpty()}>Start 0 tokens</button>
<button data-testid="start-3" onclick={() => startTokens(3)}>Start 3 tokens</button>
<button data-testid="start-10" onclick={() => startTokens(10)}>Start 10 tokens</button>
<button data-testid="start-boom" onclick={startBoom}>Start boom</button>
<button data-testid="start-boom-immediate" onclick={startBoomImmediate}>Start boom-immediate</button>
<button data-testid="start-typed-error" onclick={startTypedError}>Start typed-error</button>
<button data-testid="start-cancel-observe" onclick={startCancelObserve}>Start cancel-observe</button>
<button data-testid="cancel" onclick={cancelStream}>Cancel</button>

<span data-testid="status">{status}</span>
<span data-testid="stream-id">{lastStreamId}</span>
<span data-testid="stream-ok">{streamOkReceived ? 'yes' : 'no'}</span>
<span data-testid="chunk-indices">{chunkIndices.join(',')}</span>
<span data-testid="stream-error">{streamError}</span>
<span data-testid="stream-end">{streamEnd ? 'yes' : 'no'}</span>
<span data-testid="cancel-observed">{cancelObserved ? 'yes' : 'no'}</span>
