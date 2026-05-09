<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let subscribed = $state(false);
	let responses = $state<Record<string, string>>({});

	let correlationCounter = 0;

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const room = new URL(location.href).searchParams.get('room') ?? 'default';
		ws = new WebSocket(
			`${protocol}//${location.host}/ws/request?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
			if (data.event === '_subscribeOk') subscribed = true;
			const id = data.payload?._correlationId as string | undefined;
			if (id) {
				responses = { ...responses, [id]: JSON.stringify(data.payload ?? {}) };
			}
		};
	}

	function request(event: string, payload: Record<string, unknown> = {}) {
		const id = `req-${++correlationCounter}`;
		ws?.send(JSON.stringify({ event, payload: { ...payload, _correlationId: id } }));
		return id;
	}

	function getTime() {
		return request('get-time');
	}
	function getNsInfo() {
		return request('get-ns-info', { _namespace: 'ns' });
	}
	function getChannelInfo() {
		return request('get-channel-info', { _channel: 'room' });
	}
	function subscribeRoom() {
		ws?.send(JSON.stringify({ event: '_subscribe', payload: { _channel: 'room' } }));
	}
	function noResponse() {
		return request('no-response');
	}
	function doubleResponse() {
		return request('double-response');
	}
	function strictEcho() {
		return request('strict-echo', { id: 'value-42' });
	}
	function throwingRequest() {
		return request('throwing-request');
	}
	function malformedStrictEcho() {
		// Wrong type for the strict-echo schema (`id` must be a string). The
		// server emits a validation `_error`; the test asserts it carries
		// `_correlationId` so the request settles instead of hanging.
		return request('strict-echo', { id: 42 } as unknown as Record<string, unknown>);
	}

	let lastId = $state('');
	function click(fn: () => string) {
		lastId = fn();
	}
</script>

<h1>request feature</h1>
<input data-testid="username" bind:value={username} />
<button data-testid="connect" onclick={connect}>Connect</button>
<button data-testid="subscribe-room" onclick={subscribeRoom}>Subscribe room</button>
<button data-testid="get-time" onclick={() => click(getTime)}>Get time</button>
<button data-testid="get-ns-info" onclick={() => click(getNsInfo)}>Get ns info</button>
<button data-testid="get-ch-info" onclick={() => click(getChannelInfo)}>Get channel info</button>
<button data-testid="no-response" onclick={() => click(noResponse)}>No response</button>
<button data-testid="double-response" onclick={() => click(doubleResponse)}>Double response</button>
<button data-testid="strict-echo" onclick={() => click(strictEcho)}>Strict echo</button>
<button data-testid="throwing-request" onclick={() => click(throwingRequest)}>Throwing request</button>
<button data-testid="malformed-strict-echo" onclick={() => click(malformedStrictEcho)}>Malformed strict echo</button>

<span data-testid="status">{status}</span>
<span data-testid="subscribed">{subscribed ? 'yes' : 'no'}</span>
<span data-testid="last-id">{lastId}</span>
<span data-testid="last-response">{responses[lastId] ?? ''}</span>
