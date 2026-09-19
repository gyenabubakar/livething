<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	// Most recent value observed per key, serialised as `key=value`.
	// `null` is rendered as the literal string `null` so the test can match it.
	let lastValueForKey = $state<Record<string, string>>({});
	let listKeys = $state<string[]>([]);

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

			const data = window.__livethingDecode(ev.data);
			if (data.event === 'kv-result') {
				const { key, value } = data.payload ?? {};
				lastValueForKey = { ...lastValueForKey, [key]: value === null ? 'null' : String(value) };
			}

			if (data.event === 'kv-list-result') {
				listKeys = data.payload?.keys ?? [];
			}
		};
	}

	function kvSet(key: string, value: string, ttlMs?: number) {
		ws?.send(window.__livethingEncode({ event: 'kv-set', payload: { key, value, ttlMs } }));
	}

	function kvGet(key: string) {
		ws?.send(window.__livethingEncode({ event: 'kv-get', payload: { key } }));
	}

	function kvDelete(key: string) {
		ws?.send(window.__livethingEncode({ event: 'kv-delete', payload: { key } }));
	}

	function kvSetGet(key: string, value: string) {
		ws?.send(window.__livethingEncode({ event: 'kv-set-get', payload: { key, value } }));
	}

	function kvListProbe(prefix: string) {
		ws?.send(window.__livethingEncode({ event: 'kv-list-probe', payload: { prefix } }));
	}

	function kvTtlZeroProbe(key: string, value: string) {
		ws?.send(window.__livethingEncode({ event: 'kv-ttl-zero-probe', payload: { key, value } }));
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

<button data-testid="get-nonexistent" onclick={() => kvGet('nonexistent')}>Get nonexistent</button>
<button data-testid="set-overwrite-v1" onclick={() => kvSet('overwrite', 'first')}>
	Set overwrite=first
</button>
<button data-testid="set-overwrite-v2" onclick={() => kvSet('overwrite', 'second')}>
	Set overwrite=second
</button>
<button data-testid="get-overwrite" onclick={() => kvGet('overwrite')}>Get overwrite</button>

<button data-testid="delete-never-set" onclick={() => kvDelete('never-set')}>Delete never-set</button>
<button data-testid="get-never-set" onclick={() => kvGet('never-set')}>Get never-set</button>

<button data-testid="set-get-atomic" onclick={() => kvSetGet('atomic', 'atomic-val')}>
	Set then get atomic
</button>

<button data-testid="kv-list" onclick={() => kvListProbe('pfx')}>List under pfx</button>
<button data-testid="kv-ttl-zero" onclick={() => kvTtlZeroProbe('k0', 'stays')}>
	Set k0 with ttl:0
</button>

<span data-testid="status">{status}</span>
<span data-testid="kv-list-keys">{listKeys.join(',')}</span>
<span data-testid="value-ttl-zero">{latest('k0')}</span>
<span data-testid="value-basic">{latest('basic')}</span>
<span data-testid="value-gone">{latest('gone')}</span>
<span data-testid="value-ttl">{latest('ttl')}</span>
<span data-testid="value-nonexistent">{latest('nonexistent')}</span>
<span data-testid="value-overwrite">{latest('overwrite')}</span>
<span data-testid="value-never-set">{latest('never-set')}</span>
<span data-testid="value-atomic">{latest('atomic')}</span>
