<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let titles = $state<string[]>([]);
	let oneCount = $state<number | null>(null);
	let oneEmptyCount = $state<number | null>(null);
	let rawRows = $state<string>('');
	let reuseError = $state<string>('');
	let snapshotCount = $state<number | null>(null);
	let snapshotShapeOk = $state<boolean | null>(null);

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

			const data = window.__livethingDecode(ev.data);
			if (data.event === 'notes-list') {
				titles = (data.payload?.notes ?? []).map((n: { title: string }) => n.title);
			}

			if (data.event === 'sql-one-result') {
				oneCount = data.payload?.row?.c ?? null;
			}

			if (data.event === 'sql-one-empty-result') {
				oneEmptyCount = data.payload?.row?.c ?? null;
			}

			if (data.event === 'sql-raw-result') {
				rawRows = JSON.stringify(data.payload?.rows ?? []);
			}

			if (data.event === 'sql-reuse-result') {
				reuseError = data.payload?.error ?? '';
			}

			if (data.event === 'snapshot-result') {
				snapshotCount = data.payload?.count ?? null;
				snapshotShapeOk = data.payload?.shapeOk ?? null;
			}
		};
	}

	function saveNote(title: string, body: string) {
		ws?.send(window.__livethingEncode({ event: 'save-note', payload: { title, body } }));
	}

	function getNotes() {
		ws?.send(window.__livethingEncode({ event: 'get-notes', payload: {} }));
	}

	function sqlOne() {
		ws?.send(window.__livethingEncode({ event: 'sql-one-probe', payload: {} }));
	}

	function sqlRaw() {
		ws?.send(window.__livethingEncode({ event: 'sql-raw-probe', payload: {} }));
	}

	function sqlOneEmpty() {
		ws?.send(window.__livethingEncode({ event: 'sql-one-empty-probe', payload: {} }));
	}

	function sqlReuse() {
		ws?.send(window.__livethingEncode({ event: 'sql-reuse-probe', payload: {} }));
	}

	function sqlTxCommit() {
		ws?.send(window.__livethingEncode({ event: 'sql-tx-commit-probe', payload: {} }));
	}

	function sqlTxRollback() {
		ws?.send(window.__livethingEncode({ event: 'sql-tx-rollback-probe', payload: {} }));
	}

	function sqlOneMulti() {
		ws?.send(window.__livethingEncode({ event: 'sql-one-multi-probe', payload: {} }));
	}

	function connectionsSnapshot() {
		ws?.send(window.__livethingEncode({ event: 'connections-snapshot-probe', payload: {} }));
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
<button data-testid="sql-one-empty" onclick={sqlOneEmpty}>SqlOne empty probe</button>
<button data-testid="sql-raw" onclick={sqlRaw}>SqlRaw probe</button>
<button data-testid="sql-reuse" onclick={sqlReuse}>SqlReuse probe</button>
<button data-testid="sql-tx-commit" onclick={sqlTxCommit}>Tx commit probe</button>
<button data-testid="sql-tx-rollback" onclick={sqlTxRollback}>Tx rollback probe</button>
<button data-testid="sql-one-multi" onclick={sqlOneMulti}>One multi probe</button>
<button data-testid="connections-snapshot" onclick={connectionsSnapshot}>Snapshot probe</button>

<span data-testid="status">{status}</span>
<span data-testid="note-titles">{titles.join(',')}</span>
<span data-testid="one-count">{oneCount ?? ''}</span>
<span data-testid="one-empty-count">{oneEmptyCount ?? ''}</span>
<span data-testid="raw-rows">{rawRows}</span>
<span data-testid="reuse-error">{reuseError}</span>
<span data-testid="snapshot-count">{snapshotCount ?? ''}</span>
<span data-testid="snapshot-shape-ok">{snapshotShapeOk === null ? '' : String(snapshotShapeOk)}</span>
