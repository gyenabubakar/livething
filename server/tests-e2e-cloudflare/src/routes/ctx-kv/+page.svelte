<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	// Most recent value observed per key, serialised as `key=value`.
	// `null` is rendered as the literal string `null` so the test can match it.
	let lastValueForKey = $state<Record<string, string>>({});

	function latest(key: string) {
		return lastValueForKey[key] ?? '';
	}

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-kv?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'kv-result') {
				const { key, value } = data.payload ?? {};
				lastValueForKey = { ...lastValueForKey, [key]: value === null ? 'null' : String(value) };
			}
		};
	}

	function kvSet(key: string, value: string, ttlMs?: number) {
		ws?.send(JSON.stringify({ event: 'kv-set', payload: { key, value, ttlMs } }));
	}
	function kvGet(key: string) {
		ws?.send(JSON.stringify({ event: 'kv-get', payload: { key } }));
	}
	function kvDelete(key: string) {
		ws?.send(JSON.stringify({ event: 'kv-delete', payload: { key } }));
	}
</script>

<h1>ctx-kv feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="set-basic" onclick={() => kvSet('basic', 'hello')}>Set basic=hello</button>
<button data-testid="get-basic" onclick={() => kvGet('basic')}>Get basic</button>

<button data-testid="set-gone" onclick={() => kvSet('gone', 'here')}>Set gone=here</button>
<button data-testid="delete-gone" onclick={() => kvDelete('gone')}>Delete gone</button>
<button data-testid="get-gone" onclick={() => kvGet('gone')}>Get gone</button>

<button data-testid="set-ttl" onclick={() => kvSet('ttl', 'ephemeral', 300)}>
	Set ttl=ephemeral (300ms)
</button>
<button data-testid="get-ttl" onclick={() => kvGet('ttl')}>Get ttl</button>

<span data-testid="status">{status}</span>
<span data-testid="value-basic">{latest('basic')}</span>
<span data-testid="value-gone">{latest('gone')}</span>
<span data-testid="value-ttl">{latest('ttl')}</span>
