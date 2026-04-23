<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let lastStreamId = $state('');
	let tokens = $state('');
	let streamEnd = $state(false);

	function reset() {
		lastStreamId = '';
		tokens = '';
		streamEnd = false;
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
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			switch (data.event) {
				case '_streamOk':
					if (data.payload?._streamId) lastStreamId = data.payload._streamId;
					break;
				case '_streamEnd':
					streamEnd = true;
					break;
				case 'start-nudge-stream':
					if (typeof data.payload?.token === 'string') tokens += data.payload.token;
					break;
			}
		};
	}

	function start(prompt: string) {
		reset();
		ws?.send(JSON.stringify({ event: 'start-nudge-stream', payload: { prompt } }));
	}
	function pause() {
		ws?.send(JSON.stringify({ event: 'pause', payload: { _streamId: lastStreamId } }));
	}
	function pauseMultiple(count: number) {
		for (let i = 0; i < count; i++) {
			ws?.send(JSON.stringify({ event: 'pause', payload: { _streamId: lastStreamId } }));
		}
	}
	function speedUp(factor: number) {
		ws?.send(
			JSON.stringify({ event: 'speed-up', payload: { factor, _streamId: lastStreamId } }),
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
<button data-testid="pause-multiple" onclick={() => pauseMultiple(3)}>Pause x3</button>
<button data-testid="speed-up" onclick={() => speedUp(50)}>Speed up x50</button>

<span data-testid="status">{status}</span>
<span data-testid="stream-id">{lastStreamId}</span>
<span data-testid="tokens">{tokens}</span>
<span data-testid="stream-end">{streamEnd ? 'yes' : 'no'}</span>
