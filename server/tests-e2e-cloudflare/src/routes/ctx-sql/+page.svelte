<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let titles = $state<string[]>([]);
	let oneCount = $state<number | null>(null);
	let rawRows = $state<string>('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/ctx-sql?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === 'notes-list') {
				titles = (data.payload?.notes ?? []).map((n: { title: string }) => n.title);
			}
			if (data.event === 'sql-one-result') {
				oneCount = data.payload?.row?.c ?? null;
			}
			if (data.event === 'sql-raw-result') {
				rawRows = JSON.stringify(data.payload?.rows ?? []);
			}
		};
	}

	function saveNote(title: string, body: string) {
		ws?.send(JSON.stringify({ event: 'save-note', payload: { title, body } }));
	}
	function getNotes() {
		ws?.send(JSON.stringify({ event: 'get-notes', payload: {} }));
	}
	function sqlOne() {
		ws?.send(JSON.stringify({ event: 'sql-one-probe', payload: {} }));
	}
	function sqlRaw() {
		ws?.send(JSON.stringify({ event: 'sql-raw-probe', payload: {} }));
	}
</script>

<h1>ctx-sql feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button data-testid="save-note" onclick={() => saveNote('Test Note', 'the body')}>
	Save Test Note
</button>
<button data-testid="get-notes" onclick={getNotes}>Get notes</button>
<button data-testid="sql-one" onclick={sqlOne}>SqlOne probe</button>
<button data-testid="sql-raw" onclick={sqlRaw}>SqlRaw probe</button>

<span data-testid="status">{status}</span>
<span data-testid="note-titles">{titles.join(',')}</span>
<span data-testid="one-count">{oneCount ?? ''}</span>
<span data-testid="raw-rows">{rawRows}</span>
