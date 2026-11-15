<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('user');
	let publicMembers = $state('');
	let privateMembers = $state('');
	let kickAck = $state('');
	let kicked = $state<string[]>([]);
	let memberLeaves = $state<string[]>([]);
	let publicMessages = $state<string[]>([]);
	let privateMessages = $state<string[]>([]);

	function connect() {
		if (ws) return;

		status = 'connecting';
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${proto}//${location.host}/ws/channel-family-isolation?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

			const data = window.__livethingDecode(ev.data);
			if (data.event === 'public-members-result') {
				publicMembers = `${data.payload.name}:${data.payload.count}`;
			}

			if (data.event === 'private-members-result') {
				privateMembers = `${data.payload.name}:${data.payload.count}`;
			}

			if (data.event === 'kick-acknowledged') {
				kickAck = data.payload.where;
			}

			if (data.event === '__kicked__') {
				kicked = [
					...kicked,
					`${data.metadata?.channel?.family ?? 'static'}:${data.metadata?.channel?.name}:${data.payload.reason ?? ''}`,
				];
			}

			if (data.event === '__memberChanges__') {
				for (const change of data.payload.changes) {
					if (change.kind !== 'leave') continue;

					memberLeaves = [
						...memberLeaves,
						`${data.metadata?.channel?.family ?? 'static'}:${data.metadata?.channel?.name ?? ''}:${change.memberId ?? ''}`,
					];
				}
			}

			if (data.event === 'room-message') {
				publicMessages = [
					...publicMessages,
					`${data.payload.family}:${data.payload.name}:${data.payload.text}`,
				];
			}

			if (data.event === 'private-message') {
				privateMessages = [
					...privateMessages,
					`${data.payload.family}:${data.payload.name}:${data.payload.text}`,
				];
			}
		};
	}

	function send(payload: unknown) {
		ws?.send(window.__livethingEncode(payload));
	}
</script>

<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>

<button
	data-testid="sub-public"
	onclick={() =>
		send({
			event: '__subscribe__',
			payload: null,
			metadata: { channel: { name: 'room:1', family: 'publicRooms' } },
		})}
>
	Subscribe public room:1
</button>
<button
	data-testid="sub-private"
	onclick={() =>
		send({
			event: '__subscribe__',
			payload: null,
			metadata: { channel: { name: 'room:1', family: 'privateRooms' } },
		})}
>
	Subscribe private room:1
</button>

<button
	data-testid="get-public-members"
	onclick={() => send({ event: 'public-members', payload: { name: 'room:1' } })}
>
	Get public members
</button>
<button
	data-testid="get-private-members"
	onclick={() => send({ event: 'private-members', payload: { name: 'room:1' } })}
>
	Get private members
</button>

<button
	data-testid="kick-public-target"
	onclick={() =>
		send({ event: 'kick-in-public', payload: { name: 'room:1', tag: 'target', reason: 'cleanup' } })}
>
	Kick public
</button>
<button
	data-testid="kick-private-target"
	onclick={() =>
		send({
			event: 'kick-in-private',
			payload: { name: 'room:1', tag: 'target', reason: 'cleanup' },
		})}
>
	Kick private
</button>

<button
	data-testid="broadcast-public"
	onclick={() =>
		send({
			event: 'public-broadcast-from-top',
			payload: { name: 'room:1', text: 'pub-hello' },
		})}
>
	Broadcast public
</button>
<button
	data-testid="send-direct-public"
	onclick={() => send({ event: 'public-send-direct', payload: { name: 'room:1', text: 'direct-pub' } })}
>
	Send direct public
</button>
<button
	data-testid="send-direct-private"
	onclick={() => send({ event: 'private-send-direct', payload: { name: 'room:1', text: 'direct-priv' } })}
>
	Send direct private
</button>

<button
	data-testid="replay-from-zero"
	onclick={() =>
		send({
			event: '__replay__',
			payload: { lastKnownSeq: 0 },
			metadata: { channel: { name: 'room:1', family: 'publicRooms' } },
		})}
>
	Replay since 0
</button>

<span data-testid="status">{status}</span>
<span data-testid="public-members">{publicMembers}</span>
<span data-testid="private-members">{privateMembers}</span>
<span data-testid="kick-ack">{kickAck}</span>
<span data-testid="kicked">{kicked.join(',')}</span>
<span data-testid="member-leaves">{memberLeaves.join(',')}</span>
<span data-testid="public-messages">{publicMessages.join(',')}</span>
<span data-testid="private-messages">{privateMessages.join(',')}</span>
