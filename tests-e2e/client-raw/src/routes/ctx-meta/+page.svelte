<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let echoed = $state('');
	let membersList = $state('');
	let broadcastReceived = $state('');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-meta?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'who-am-i-result') echoed = data.payload?.username ?? '';
			if (data.event === 'members-list-result') {
				membersList = (data.payload?.members ?? []).join(', ');
			}

			if (data.event === 'broadcast-identity-received') {
				broadcastReceived = data.payload?.from ?? '';
			}
		};
	}

	function askWhoAmI() {
		ws?.send(window.__livethingEncode({ event: 'who-am-i', payload: {} }));
	}

	function listMembers() {
		ws?.send(window.__livethingEncode({ event: 'list-members', payload: {} }));
	}

	function broadcastIdentity() {
		ws?.send(window.__livethingEncode({ event: 'broadcast-identity', payload: {} }));
	}
</script>

<h1>ctx-meta feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="who-am-i" onclick={askWhoAmI}>Who am I</button>
<button data-testid="list-members" onclick={listMembers}>List Members</button>
<button data-testid="broadcast-identity" onclick={broadcastIdentity}>Broadcast Identity</button>
<span data-testid="status">{status}</span>
<span data-testid="echoed-username">{echoed}</span>
<span data-testid="members-list">{membersList}</span>
<span data-testid="broadcast-received">{broadcastReceived}</span>
