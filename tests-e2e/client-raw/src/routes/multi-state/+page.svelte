<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('multiuser');
	let batchAcks = $state(0);

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/multi-state?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			const data = window.__livethingDecode(ev.data);
			if (data.event === 'tag-batch-done') batchAcks += 1;
		};
	}

	function sendAdd() {
		ws?.send(window.__livethingEncode({ event: 'add-five-tags', payload: {} }));
	}

	function sendRemove() {
		ws?.send(window.__livethingEncode({ event: 'remove-five-tags', payload: {} }));
	}
</script>

<h1>multi-state batch fixture</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="add-batch" onclick={sendAdd}>Add 5 tags</button>
<button data-testid="remove-batch" onclick={sendRemove}>Remove 5 tags</button>
<span data-testid="status">{status}</span>
<span data-testid="batch-acks">{batchAcks}</span>
