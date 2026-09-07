<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let tags = $state('');
	let connCount = $state<number | null>(null);
	let byTag = $state('');

	function connect() {
		if (ws) return;

		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-tags?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);

		(window as unknown as { __ws: WebSocket }).__ws = ws;
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
			if (data.event === 'tag-result') tags = data.payload?.tags ?? '';
			if (data.event === 'connection-info') connCount = data.payload?.count ?? null;
			if (data.event === 'connections-by-tag-result') {
				byTag = `${data.payload?.tag}:${data.payload?.count}`;
			}
		};
	}

	function tagSelf(tag: string) {
		ws?.send(JSON.stringify({ event: 'tag-self', payload: { tag } }));
	}

	function untagSelf(tag: string) {
		ws?.send(JSON.stringify({ event: 'untag-self', payload: { tag } }));
	}

	function connInfo() {
		ws?.send(JSON.stringify({ event: 'get-connection-info', payload: {} }));
	}

	function getByTag(tag: string) {
		ws?.send(JSON.stringify({ event: 'get-by-tag', payload: { tag } }));
	}
</script>

<h1>ctx-tags feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="tag-vip" onclick={() => tagSelf('vip')}>Tag vip</button>
<button data-testid="untag-vip" onclick={() => untagSelf('vip')}>Untag vip</button>
<button data-testid="conn-info" onclick={connInfo}>Conn info</button>
<button data-testid="get-by-username" onclick={() => getByTag(username)}>Get by username</button>

<span data-testid="status">{status}</span>
<span data-testid="tags">{tags}</span>
<span data-testid="conn-count">{connCount ?? ''}</span>
<span data-testid="by-tag">{byTag}</span>
