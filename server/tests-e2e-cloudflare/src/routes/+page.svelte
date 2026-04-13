<script lang="ts">
	let ws: WebSocket | null = $state(null);
	let status = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');
	let username = $state('testuser');
	let correlationCounter = 0;

	let echoResult = $state('');
	let ackReceived = $state(false);
	let errorResult = $state('');
	let userEvents = $state<string[]>([]);
	let chatMessages = $state<string[]>([]);
	let chatSubscribed = $state(false);
	let timeResult = $state('');
	let aiResponse = $state('');
	let aiStreamTokens = $state('');
	let aiStreamDone = $state(false);
	let aiModelResult = $state('');
	let scheduledResult = $state('');
	let lastSeq = $state(0);
	let messageLog = $state<string[]>([]);

	const pendingRequests = new Map<string, (payload: Record<string, unknown>) => void>();

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(`${protocol}//${location.host}/ws?username=${encodeURIComponent(username)}`);

		ws.onopen = () => {
			status = 'connected';
		};

		ws.onclose = () => {
			status = 'disconnected';
			ws = null;
			chatSubscribed = false;
		};

		ws.onerror = () => {
			status = 'disconnected';
			ws = null;
		};

		ws.onmessage = (event) => {
			if (event.data === 'pong') return;

			const msg = JSON.parse(event.data as string) as {
				event: string;
				payload: Record<string, unknown>;
			};
			const { event: evt, payload } = msg;

			if (payload?._seq) lastSeq = payload._seq as number;
			messageLog = [...messageLog, `${evt}: ${JSON.stringify(payload)}`].slice(-50);

			if (payload?._correlationId) {
				const resolve = pendingRequests.get(payload._correlationId as string);
				if (resolve) {
					pendingRequests.delete(payload._correlationId as string);
					resolve(payload);
					return;
				}
			}

			switch (evt) {
				case '_ack':
					ackReceived = true;
					break;
				case '_error':
					errorResult = `${payload.code}: ${JSON.stringify(payload.detail ?? {})}`;
					break;
				case '_subscribeOk':
					if (payload._channel === 'chat') chatSubscribed = true;
					break;
				case '_streamOk':
					aiStreamTokens = '';
					aiStreamDone = false;
					break;
				case '_streamEnd':
					aiStreamDone = true;
					break;
				case 'echoed':
					echoResult = `${payload.from}: ${payload.text}`;
					break;
				case 'user-joined':
					userEvents = [...userEvents, `joined: ${payload.username}`];
					break;
				case 'user-left':
					userEvents = [...userEvents, `left: ${payload.username}`];
					break;
				case 'chat-message':
					chatMessages = [...chatMessages, `${payload.from}: ${payload.text}`].slice(-20);
					break;
				case 'cleanup-done':
					scheduledResult = `Cleaned ${payload.itemsCleaned} items`;
					break;
				default:
					if (payload?._namespace === 'ai') {
						if (evt === 'response') {
							aiResponse = payload.text as string;
						} else if (evt === 'get-model') {
							aiModelResult = `${payload.name} (max: ${payload.maxTokens})`;
						} else if (evt === 'stream-prompt') {
							aiStreamTokens += payload.token;
						}
					}
					break;
			}
		};
	}

	function disconnect() {
		ws?.close();
	}

	function send(event: string, payload: Record<string, unknown> = {}) {
		ws?.send(JSON.stringify({ event, payload }));
	}

	function sendEcho() {
		ackReceived = false;
		send('echo', { text: 'hello world', _ackId: `ack_${++correlationCounter}` });
	}

	function triggerError(code: 'not-found' | 'forbidden') {
		errorResult = '';
		send('trigger-error', { code });
	}

	function requestTime() {
		const id = `corr_${++correlationCounter}`;
		send('get-time', { _correlationId: id });
		pendingRequests.set(id, (payload) => {
			timeResult = `${payload.iso} (epoch: ${payload.epoch})`;
		});
	}

	function joinChat() {
		send('_subscribe', { _channel: 'chat' });
	}

	function leaveChat() {
		chatSubscribed = false;
		send('_unsubscribe', { _channel: 'chat' });
	}

	function sendChat(text: string) {
		send('send-chat', { text, _channel: 'chat' });
	}

	function sendAiMessage(text: string) {
		aiResponse = '';
		send('send', { text, _namespace: 'ai' });
	}

	function requestAiModel() {
		const id = `corr_${++correlationCounter}`;
		send('get-model', { _correlationId: id, _namespace: 'ai' });
		pendingRequests.set(id, (payload) => {
			aiModelResult = `${payload.name} (max: ${payload.maxTokens})`;
		});
	}

	function startAiStream(prompt: string) {
		aiStreamTokens = '';
		aiStreamDone = false;
		send('stream-prompt', { prompt, _namespace: 'ai' });
	}

	function scheduleCleanup() {
		scheduledResult = '';
		send('schedule-cleanup', { delaySec: 1 });
	}
</script>

<main>
	<h1>wskit e2e test</h1>

	<section data-testid="connection">
		<h2>Connection</h2>
		<input data-testid="username-input" bind:value={username} placeholder="username" />
		<button data-testid="connect-btn" onclick={connect} disabled={status !== 'disconnected'}>Connect</button>
		<button data-testid="disconnect-btn" onclick={disconnect} disabled={status !== 'connected'}>Disconnect</button>
		<span data-testid="status">{status}</span>
	</section>

	<section data-testid="echo">
		<h2>Echo + Ack</h2>
		<button data-testid="echo-btn" onclick={sendEcho} disabled={status !== 'connected'}>Send Echo</button>
		<div data-testid="echo-result">{echoResult}</div>
		<div data-testid="ack-result">{ackReceived ? 'acked' : ''}</div>
	</section>

	<section data-testid="errors">
		<h2>Errors</h2>
		<button data-testid="error-notfound-btn" onclick={() => triggerError('not-found')} disabled={status !== 'connected'}>Trigger not-found</button>
		<button data-testid="error-forbidden-btn" onclick={() => triggerError('forbidden')} disabled={status !== 'connected'}>Trigger forbidden</button>
		<div data-testid="error-result">{errorResult}</div>
	</section>

	<section data-testid="request">
		<h2>Request (get-time)</h2>
		<button data-testid="request-time-btn" onclick={requestTime} disabled={status !== 'connected'}>Get Time</button>
		<div data-testid="time-result">{timeResult}</div>
	</section>

	<section data-testid="lifecycle">
		<h2>User Events</h2>
		<div data-testid="user-events">{userEvents.join(' | ')}</div>
	</section>

	<section data-testid="chat">
		<h2>Chat Channel</h2>
		<button data-testid="chat-join-btn" onclick={joinChat} disabled={status !== 'connected' || chatSubscribed}>Join</button>
		<button data-testid="chat-leave-btn" onclick={leaveChat} disabled={!chatSubscribed}>Leave</button>
		<button data-testid="chat-send-btn" onclick={() => sendChat('hi from e2e')} disabled={!chatSubscribed}>Send "hi from e2e"</button>
		<div data-testid="chat-subscribed">{chatSubscribed ? 'subscribed' : ''}</div>
		<div data-testid="chat-messages">{chatMessages.join(' | ')}</div>
	</section>

	<section data-testid="ai">
		<h2>AI Namespace</h2>
		<button data-testid="ai-send-btn" onclick={() => sendAiMessage('hello AI')} disabled={status !== 'connected'}>Send to AI</button>
		<button data-testid="ai-model-btn" onclick={requestAiModel} disabled={status !== 'connected'}>Get Model</button>
		<button data-testid="ai-stream-btn" onclick={() => startAiStream('tell me a story')} disabled={status !== 'connected'}>Start Stream</button>
		<div data-testid="ai-response">{aiResponse}</div>
		<div data-testid="ai-model-result">{aiModelResult}</div>
		<div data-testid="ai-stream-tokens">{aiStreamTokens}</div>
		<div data-testid="ai-stream-done">{aiStreamDone ? 'stream-done' : ''}</div>
	</section>

	<section data-testid="scheduled">
		<h2>Scheduled Task</h2>
		<button data-testid="schedule-btn" onclick={scheduleCleanup} disabled={status !== 'connected'}>Schedule Cleanup (1s)</button>
		<div data-testid="scheduled-result">{scheduledResult}</div>
	</section>

	<section data-testid="sequence">
		<h2>Sequence</h2>
		<div data-testid="last-seq">{lastSeq}</div>
	</section>

	<section data-testid="log">
		<h2>Message Log</h2>
		<div data-testid="message-log">{messageLog.join('\n')}</div>
	</section>
</main>

<style>
	main { font-family: monospace; padding: 1rem; max-width: 800px; }
	section { margin: 1rem 0; padding: 0.5rem; border: 1px solid #ccc; }
	button { margin: 0.25rem; }
	h2 { margin: 0 0 0.5rem; font-size: 1rem; }
</style>
