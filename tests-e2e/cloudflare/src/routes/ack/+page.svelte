<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let ackIds = $state<string[]>([]);
	let ackCheckOk = $state(false);

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ack?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_ack') {
				const id = data.payload?._ackId;
				if (id) ackIds = [...ackIds, id];
			}
			if (data.event === 'ack-check-ok') ackCheckOk = true;
		};
	}

	function sendAckCheck(ackId: string) {
		ws?.send(JSON.stringify({ event: 'ack-check', payload: { _ackId: ackId } }));
	}

	function sendThrow(ackId: string) {
		ws?.send(JSON.stringify({ event: 'throw-me', payload: { _ackId: ackId } }));
	}

	function sendNoAckId() {
		ws?.send(JSON.stringify({ event: 'ack-check', payload: {} }));
	}
</script>

<h1>ack feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="send-ok" onclick={() => sendAckCheck('ack-ok')}>Send (ack-ok)</button>
<button data-testid="send-ok-2" onclick={() => sendAckCheck('ack-ok-2')}>Send (ack-ok-2)</button>
<button data-testid="send-throw" onclick={() => sendThrow('ack-throw')}>Throw (ack-throw)</button>
<button data-testid="send-no-ack-id" onclick={sendNoAckId}>Send (no _ackId)</button>
<span data-testid="status">{status}</span>
<span data-testid="reply">{ackCheckOk ? 'yes' : 'no'}</span>
<span data-testid="ack-ids">{ackIds.join(',')}</span>
