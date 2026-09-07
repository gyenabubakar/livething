<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let closeCode = $state<number | null>(null);
	let username = $state('testuser');
	let connectedUser = $state('');
	let disconnectedUsers = $state<string[]>([]);
	let validationErrorFired = $state('');
	let errorMessage = $state('');
	let upgradeMeta = $state('');
	let connectCount = $state('');
	let asyncHookComplete = $state('');
	let disconnectCloseEntries = $state<string[]>([]);

	function connect() {
		if (ws) return;

		status = 'connecting';
		closeCode = null;
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';

		ws = new WebSocket(
			`${protocol}//${location.host}/ws/lifecycle-hooks?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = (ev) => {
			closeCode = ev.code;
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;

			const data = JSON.parse(ev.data);
			if (data.event === 'connected') connectedUser = data.payload?.username ?? '';
			if (data.event === 'disconnected') {
				disconnectedUsers = [...disconnectedUsers, data.payload?.username ?? ''];
			}

			if (data.event === 'validation-error-fired') {
				validationErrorFired = data.payload?.event ?? '';
			}

			if (data.event === 'error-fired') {
				errorMessage = data.payload?.message ?? '';
			}

			if (data.event === 'upgrade-meta') {
				upgradeMeta = data.payload?.username ?? '';
			}

			if (data.event === 'connect-count') {
				connectCount = String(data.payload?.count ?? '');
			}

			if (data.event === 'async-hook-complete') {
				asyncHookComplete = data.payload?.complete ? 'yes' : 'no';
			}

			if (data.event === 'disconnect-close') {
				disconnectCloseEntries = [
					...disconnectCloseEntries,
					`${data.payload?.username ?? ''}:${data.payload?.code ?? ''}:${data.payload?.reason ?? ''}`,
				];
			}
		};
	}

	function sendBadEvent() {
		ws?.send(JSON.stringify({ event: 'bad-event', payload: { value: 'not-a-number' } }));
	}

	function triggerError() {
		ws?.send(JSON.stringify({ event: 'trigger-error', payload: {} }));
	}

	function disconnectSelf() {
		ws?.close();
	}
</script>

<h1>lifecycle-hooks feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="disconnect" onclick={disconnectSelf}>Disconnect self</button>
<button data-testid="send-bad" onclick={sendBadEvent}>Send bad event</button>
<button data-testid="trigger-error" onclick={triggerError}>Trigger error</button>

<span data-testid="status">{status}</span>
<span data-testid="close-code">{closeCode ?? ''}</span>
<span data-testid="connected-user">{connectedUser}</span>
<span data-testid="disconnected-users">{disconnectedUsers.join(',')}</span>
<span data-testid="validation-error">{validationErrorFired}</span>
<span data-testid="error-message">{errorMessage}</span>
<span data-testid="upgrade-meta">{upgradeMeta}</span>
<span data-testid="connect-count">{connectCount}</span>
<span data-testid="async-hook-complete">{asyncHookComplete}</span>
<span data-testid="disconnect-close-entries">{disconnectCloseEntries.join(' | ')}</span>
