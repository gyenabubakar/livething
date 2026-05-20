<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('user');
	let messages = $state<string[]>([]);
	let membersResult = $state('');

	function connect() {
		if (ws) return;
		status = 'connecting';
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${proto}//${location.host}/ws/channel-key-collision?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
		);
		ws.onopen = () => {
			status = 'connected';
			(window as unknown as { __ws?: WebSocket }).__ws = ws ?? undefined;
		};
		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') return;
			const data = JSON.parse(ev.data);
			if (data.event === 'hello') {
				messages = [
					...messages,
					`${data.payload.family}:${data.payload.name}:${data.payload.text}`,
				];
			}
			if (data.event === 'members-result') {
				membersResult = `${data.payload.family}:${data.payload.name}:${data.payload.count}`;
			}
		};
	}

	function send(payload: unknown) {
		ws?.send(JSON.stringify(payload));
	}
</script>

<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button
	data-testid="sub-a"
	onclick={() =>
		send({
			event: '__subscribe__',
			payload: {},
			__wskit: { channel: 'private::lobby', channelScope: 'rooms' },
		})}
>
	Subscribe family A (rooms / private::lobby)
</button>
<button
	data-testid="sub-b"
	onclick={() =>
		send({
			event: '__subscribe__',
			payload: {},
			__wskit: { channel: 'lobby', channelScope: 'rooms::private' },
		})}
>
	Subscribe family B (rooms::private / lobby)
</button>

<button
	data-testid="broadcast-a"
	onclick={() =>
		send({ event: 'broadcast-a', payload: { name: 'private::lobby', text: 'from-A' } })}
>
	Broadcast A
</button>
<button
	data-testid="broadcast-b"
	onclick={() => send({ event: 'broadcast-b', payload: { name: 'lobby', text: 'from-B' } })}
>
	Broadcast B
</button>

<button
	data-testid="members-a"
	onclick={() => send({ event: 'members-a', payload: { name: 'private::lobby' } })}
>
	Members A
</button>
<button
	data-testid="members-b"
	onclick={() => send({ event: 'members-b', payload: { name: 'lobby' } })}
>
	Members B
</button>

<span data-testid="status">{status}</span>
<span data-testid="messages">{messages.join(',')}</span>
<span data-testid="members-result">{membersResult}</span>
