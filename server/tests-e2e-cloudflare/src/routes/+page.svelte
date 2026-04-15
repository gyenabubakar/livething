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
	let aiNudgeStreamTokens = $state('');
	let aiNudgeStreamDone = $state(false);
	let aiStreamErrorResult = $state('');
	let scheduledResult = $state('');
	let cancelResult = $state('');
	let lastSeq = $state(0);
	let messageLog = $state<string[]>([]);

	let notesList = $state('');
	let kvResult = $state('');
	let connectionInfo = $state('');
	let tagResult = $state('');
	let taggedMessage = $state('');
	let binaryResult = $state('');
	let validationErrorResult = $state('');
	let deferResult = $state('');
	let blockReply = $state('');
	let channelMembersResult = $state('');
	let subscribeError = $state('');
	let streamCancelResult = $state('');

	let roomMessages = $state<string[]>([]);
	let roomSubscribed = $state(false);

	let memberJoins = $state<string[]>([]);
	let memberLeaves = $state<string[]>([]);
	let kickedResult = $state('');
	let connectionId = $state('');

	let sendToConnResult = $state('');
	let connectionsByTagResult = $state('');
	let qualityResult = $state('');
	let streamOkReceived = $state(false);

	let skipReply = $state('');
	let deferExhaustedResult = $state('');
	let heartbeatCount = $state(0);
	let flakyTaskResult = $state('');
	let broadcastStreamTokens = $state('');
	let chatInfoResult = $state('');
	let deadLetterResult = $state('');

	const pendingRequests = new Map<string, (payload: Record<string, unknown>) => void>();

	function connect() {
		if (ws) return;
		status = 'connecting';
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(`${protocol}//${location.host}/ws?username=${encodeURIComponent(username)}`);

		ws.onopen = () => {
			status = 'connected';
			(window as unknown as Record<string, unknown>).__ws = ws;
		};

		ws.onclose = (e) => {
			status = 'disconnected';
			ws = null;
			chatSubscribed = false;
			roomSubscribed = false;
		};

		ws.onerror = () => {
			status = 'disconnected';
			ws = null;
		};

		ws.binaryType = 'arraybuffer';

		ws.onmessage = (event) => {
			if (event.data === 'pong') return;

			if (event.data instanceof ArrayBuffer) {
				binaryResult = `binary:${event.data.byteLength}`;
				return;
			}

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
					if (payload._streamId) {
						aiStreamErrorResult = `stream-error:${payload.code}`;
					} else if (payload._channel) {
						subscribeError = `${payload._channel}:${payload.code}`;
					} else {
						errorResult = `${payload.code}: ${JSON.stringify(payload.detail ?? {})}`;
					}
					break;
				case '_subscribeOk':
					if (payload._channel === 'chat') chatSubscribed = true;
					if ((payload._channel as string)?.startsWith('room:')) roomSubscribed = true;
					break;
				case '_memberJoin':
					memberJoins = [...memberJoins, `${payload._channel}:${payload.connectionId}`];
					break;
				case '_memberLeave':
					memberLeaves = [...memberLeaves, `${payload._channel}:${payload.connectionId}`];
					break;
				case '_kicked':
					kickedResult = `kicked:${payload._channel}:${payload.reason}`;
					break;
				case '_streamOk':
					streamOkReceived = true;
					break;
				case '_streamEnd':
					if (aiNudgeStreamTokens && !aiNudgeStreamDone) aiNudgeStreamDone = true;
					else aiStreamDone = true;
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
				case 'room-message':
					roomMessages = [...roomMessages, `${payload.from}: ${payload.text}`].slice(-20);
					break;
				case 'cleanup-done':
					scheduledResult = `Cleaned ${payload.itemsCleaned} items`;
					break;
				case 'cleanup-cancelled':
					cancelResult = 'cancelled';
					break;
				case 'notes-list':
					notesList = JSON.stringify(payload.notes);
					break;
				case 'kv-result':
					kvResult = `${payload.key}=${JSON.stringify(payload.value)}`;
					break;
				case 'connection-info': {
					connectionInfo = `count:${payload.count}`;
					const conns = payload.connections as { id: string; tags: string[] }[];
					const self = conns.find((c) => c.tags.includes(username));
					if (self) connectionId = self.id;
					break;
				}
				case 'send-to-connection-result':
					sendToConnResult = `${payload.from}: ${payload.text}`;
					break;
				case 'connections-by-tag-result':
					connectionsByTagResult = `${payload.tag}:${(payload.ids as string[]).length}`;
					break;
				case 'quality-result':
					qualityResult = `latency:${payload.latency},quality:${payload.quality},buffered:${payload.bufferedAmount}`;
					break;
				case 'tag-result':
					tagResult = (payload.tags as string[]).join(',');
					break;
				case 'tagged-message':
					taggedMessage = `${payload.from}: ${payload.text}`;
					break;
				case 'binary-echoed':
					binaryResult = `echoed:${payload.size}`;
					break;
				case 'validation-error-fired':
					validationErrorResult = `validation-error:${payload.event}`;
					break;
				case 'defer-result':
					deferResult = 'deferred-received';
					break;
				case 'block-reply':
					blockReply = 'leaked';
					break;
				case 'stream-cancel-ack':
					streamCancelResult = 'cancelled';
					break;
				case 'channel-members':
					channelMembersResult = `${payload.channel}:${payload.count}`;
					break;
				case 'skip-reply':
					skipReply = `leaked:${payload.leaked}`;
					break;
				case 'defer-exhausted-result':
					deferExhaustedResult = `${payload.event}:retries=${payload.retries}`;
					break;
				case 'heartbeat-tick':
					heartbeatCount++;
					break;
				case 'flaky-task-result':
					flakyTaskResult = `attempts:${payload.attempts}`;
					break;
				case 'dead-letter-result':
					deadLetterResult = `${payload.taskId}:attempts=${payload.attempts}:${payload.error}`;
					break;
				default:
					if (payload?._namespace === 'ai') {
						if (evt === 'response') {
							aiResponse = payload.text as string;
						} else if (evt === 'get-model') {
							aiModelResult = `${payload.name} (max: ${payload.maxTokens})`;
						} else if (evt === 'stream-prompt') {
							aiStreamTokens += payload.token;
						} else if (evt === 'stream-with-nudges') {
							aiNudgeStreamTokens += payload.token;
						} else if (evt === 'broadcast-stream') {
							broadcastStreamTokens += payload.token;
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

	function sendEchoRewrite() {
		ackReceived = false;
		send('echo', { text: 'intercept-rewrite', _ackId: `ack_${++correlationCounter}` });
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
	function joinRoom(name: string, scope: string) {
		send('_subscribe', { _channel: name, _channelScope: scope });
	}
	function sendRoom(text: string, channel: string, scope: string) {
		send('room-send', { text, _channel: channel, _channelScope: scope });
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
	function startNudgeStream(prompt: string) {
		aiNudgeStreamTokens = '';
		aiNudgeStreamDone = false;
		send('stream-with-nudges', { prompt, _namespace: 'ai' });
	}
	function sendNudgePause() {
		send('pause', { _namespace: 'ai' });
	}
	function startErrorStream() {
		aiStreamErrorResult = '';
		send('stream-error', { _namespace: 'ai' });
	}

	function scheduleCleanup() {
		scheduledResult = '';
		send('schedule-cleanup', { delaySec: 1 });
	}
	function cancelCleanup() {
		cancelResult = '';
		send('cancel-cleanup', {});
	}

	function saveNote() {
		send('save-note', { title: 'Test Note', body: 'Hello from e2e' });
	}
	function getNotes() {
		send('get-notes', {});
	}
	function setKv() {
		send('kv-set', { key: 'test-key', value: 'test-value' });
	}
	function getKv() {
		send('kv-get', { key: 'test-key' });
	}

	function getConnectionInfo() {
		send('get-connection-info', {});
	}
	function tagSelf(tag: string) {
		send('tag-self', { tag });
	}
	function untagSelf(tag: string) {
		send('untag-self', { tag });
	}
	function sendToTag(tag: string, text: string) {
		send('send-to-tag', { tag, text });
	}
	function serverClose() {
		send('server-close', { code: 4009, reason: 'test-close' });
	}
	function forceDisconnect() {
		send('force-disconnect', {});
	}

	function sendBinary() {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		ws?.send(data.buffer);
	}

	function sendInvalidMessage() {
		ws?.send(JSON.stringify({ event: 'echo', payload: { text: 123 } }));
	}

	function sendDefer() {
		deferResult = '';
		send('defer-test', {});
	}

	function sendBlock() {
		blockReply = '';
		send('block-test', {});
	}

	function cancelStream() {
		send('_streamCancel', { _namespace: 'ai' });
	}

	function getChannelMembers(channel: string) {
		send('get-channel-members', { channel });
	}

	function kickFromChannel(channel: string, tag: string) {
		send('kick-from-channel', { channel, tag });
	}

	function sendToConnection(connectionId: string, text: string) {
		send('send-to-connection', { connectionId, text });
	}

	function getConnectionsByTag(tag: string) {
		send('get-connections-by-tag', { tag });
	}

	function getQuality() {
		send('get-quality', {});
	}

	function sendSpeedUp(factor: number) {
		send('speed-up', { factor, _namespace: 'ai' });
	}

	function sendSkipTest() {
		skipReply = '';
		send('skip-test', {});
	}

	function sendManualValidation() {
		validationErrorResult = '';
		send('manual-validation-test', { value: 'invalid' });
	}

	function sendAlwaysDefer() {
		deferExhaustedResult = '';
		send('always-defer', {});
	}

	function startHeartbeat() {
		heartbeatCount = 0;
		send('start-heartbeat', {});
	}

	function triggerFlakyTask() {
		flakyTaskResult = '';
		send('trigger-flaky-task', {});
	}

	function triggerAlwaysFail() {
		deadLetterResult = '';
		send('trigger-always-fail', {});
	}
	function queryDeadLetter() {
		send('query-dead-letter', {});
	}

	function startBroadcastStream() {
		broadcastStreamTokens = '';
		send('broadcast-stream', { prompt: 'hello broadcast world', _namespace: 'ai' });
	}

	function requestChatInfo() {
		const id = `corr_${++correlationCounter}`;
		send('get-chat-info', { _correlationId: id, _channel: 'chat' });
		pendingRequests.set(id, (payload) => {
			chatInfoResult = `${payload.channel}:members=${payload.memberCount}`;
		});
	}
</script>

<main>
	<h1>wskit e2e test</h1>

	<section>
		<h2>Connection</h2>
		<input data-testid="username-input" bind:value={username} placeholder="username" />
		<button data-testid="connect-btn" onclick={connect} disabled={status !== 'disconnected'}>Connect</button>
		<button data-testid="disconnect-btn" onclick={disconnect} disabled={status !== 'connected'}>Disconnect</button>
		<span data-testid="status">{status}</span>
	</section>

	<section>
		<h2>Echo + Ack</h2>
		<button data-testid="echo-btn" onclick={sendEcho} disabled={status !== 'connected'}>Send Echo</button>
		<button data-testid="echo-rewrite-btn" onclick={sendEchoRewrite} disabled={status !== 'connected'}>Echo (intercept rewrite)</button>
		<div data-testid="echo-result">{echoResult}</div>
		<div data-testid="ack-result">{ackReceived ? 'acked' : ''}</div>
	</section>

	<section>
		<h2>Errors</h2>
		<button data-testid="error-notfound-btn" onclick={() => triggerError('not-found')} disabled={status !== 'connected'}>Trigger not-found</button>
		<button data-testid="error-forbidden-btn" onclick={() => triggerError('forbidden')} disabled={status !== 'connected'}>Trigger forbidden</button>
		<div data-testid="error-result">{errorResult}</div>
	</section>

	<section>
		<h2>Request (get-time)</h2>
		<button data-testid="request-time-btn" onclick={requestTime} disabled={status !== 'connected'}>Get Time</button>
		<div data-testid="time-result">{timeResult}</div>
	</section>

	<section>
		<h2>User Events</h2>
		<div data-testid="user-events">{userEvents.join(' | ')}</div>
	</section>

	<section>
		<h2>Chat Channel</h2>
		<button data-testid="chat-join-btn" onclick={joinChat} disabled={status !== 'connected' || chatSubscribed}>Join</button>
		<button data-testid="chat-leave-btn" onclick={leaveChat} disabled={!chatSubscribed}>Leave</button>
		<button data-testid="chat-send-btn" onclick={() => sendChat('hi from e2e')} disabled={!chatSubscribed}>Send "hi from e2e"</button>
		<button data-testid="kick-from-channel-btn" onclick={() => kickFromChannel('chat', '')} disabled={status !== 'connected'}>Kick from Chat</button>
		<div data-testid="chat-subscribed">{chatSubscribed ? 'subscribed' : ''}</div>
		<div data-testid="chat-messages">{chatMessages.join(' | ')}</div>
		<div data-testid="member-joins">{memberJoins.join(' | ')}</div>
		<div data-testid="member-leaves">{memberLeaves.join(' | ')}</div>
		<div data-testid="kicked-result">{kickedResult}</div>
	</section>

	<section>
		<h2>Dynamic Room Channel</h2>
		<button data-testid="room-join-btn" onclick={() => joinRoom('room:general', 'rooms')} disabled={status !== 'connected'}>Join room:general</button>
		<button data-testid="room-send-btn" onclick={() => sendRoom('hi from room', 'room:general', 'rooms')} disabled={!roomSubscribed}>Send in room</button>
		<div data-testid="room-subscribed">{roomSubscribed ? 'subscribed' : ''}</div>
		<div data-testid="room-messages">{roomMessages.join(' | ')}</div>
	</section>

	<section>
		<h2>AI Namespace</h2>
		<button data-testid="ai-send-btn" onclick={() => sendAiMessage('hello AI')} disabled={status !== 'connected'}>Send to AI</button>
		<button data-testid="ai-model-btn" onclick={requestAiModel} disabled={status !== 'connected'}>Get Model</button>
		<button data-testid="ai-stream-btn" onclick={() => startAiStream('tell me a story')} disabled={status !== 'connected'}>Start Stream</button>
		<button data-testid="ai-nudge-stream-btn" onclick={() => startNudgeStream('with nudges')} disabled={status !== 'connected'}>Stream with Nudges</button>
		<button data-testid="ai-nudge-pause-btn" onclick={sendNudgePause} disabled={status !== 'connected'}>Send Pause Nudge</button>
		<button data-testid="ai-stream-error-btn" onclick={startErrorStream} disabled={status !== 'connected'}>Stream Error</button>
		<button data-testid="ai-stream-cancel-btn" onclick={cancelStream} disabled={status !== 'connected'}>Cancel Stream</button>
		<button data-testid="ai-speed-up-btn" onclick={() => sendSpeedUp(4)} disabled={status !== 'connected'}>Speed Up</button>
		<div data-testid="ai-response">{aiResponse}</div>
		<div data-testid="ai-model-result">{aiModelResult}</div>
		<div data-testid="ai-stream-tokens">{aiStreamTokens}</div>
		<div data-testid="ai-stream-done">{aiStreamDone ? 'stream-done' : ''}</div>
		<div data-testid="ai-nudge-stream-tokens">{aiNudgeStreamTokens}</div>
		<div data-testid="ai-nudge-stream-done">{aiNudgeStreamDone ? 'nudge-stream-done' : ''}</div>
		<div data-testid="ai-stream-error-result">{aiStreamErrorResult}</div>
		<div data-testid="stream-ok-received">{streamOkReceived ? 'stream-ok' : ''}</div>
	</section>

	<section>
		<h2>Scheduled Task</h2>
		<button data-testid="schedule-btn" onclick={scheduleCleanup} disabled={status !== 'connected'}>Schedule Cleanup (1s)</button>
		<button data-testid="cancel-cleanup-btn" onclick={cancelCleanup} disabled={status !== 'connected'}>Cancel Cleanup</button>
		<div data-testid="scheduled-result">{scheduledResult}</div>
		<div data-testid="cancel-result">{cancelResult}</div>
	</section>

	<section>
		<h2>Storage (SQL + KV)</h2>
		<button data-testid="save-note-btn" onclick={saveNote} disabled={status !== 'connected'}>Save Note</button>
		<button data-testid="get-notes-btn" onclick={getNotes} disabled={status !== 'connected'}>Get Notes</button>
		<button data-testid="kv-set-btn" onclick={setKv} disabled={status !== 'connected'}>KV Set</button>
		<button data-testid="kv-get-btn" onclick={getKv} disabled={status !== 'connected'}>KV Get</button>
		<div data-testid="notes-list">{notesList}</div>
		<div data-testid="kv-result">{kvResult}</div>
	</section>

	<section>
		<h2>Connections</h2>
		<button data-testid="conn-info-btn" onclick={getConnectionInfo} disabled={status !== 'connected'}>Get Info</button>
		<button data-testid="tag-self-btn" onclick={() => tagSelf('vip')} disabled={status !== 'connected'}>Tag "vip"</button>
		<button data-testid="untag-self-btn" onclick={() => untagSelf('vip')} disabled={status !== 'connected'}>Untag "vip"</button>
		<button data-testid="send-to-tag-btn" onclick={() => sendToTag('testuser', 'tagged hello')} disabled={status !== 'connected'}>SendTo "testuser"</button>
		<button data-testid="server-close-btn" onclick={serverClose} disabled={status !== 'connected'}>Server Close</button>
		<button data-testid="force-disconnect-btn" onclick={forceDisconnect} disabled={status !== 'connected'}>Force Disconnect</button>
		<button data-testid="get-quality-btn" onclick={getQuality} disabled={status !== 'connected'}>Get Quality</button>
		<button data-testid="get-connections-by-tag-btn" onclick={() => getConnectionsByTag('testuser')} disabled={status !== 'connected'}>Get By Tag</button>
		<div data-testid="connection-info">{connectionInfo}</div>
		<div data-testid="connection-id">{connectionId}</div>
		<div data-testid="tag-result">{tagResult}</div>
		<div data-testid="tagged-message">{taggedMessage}</div>
		<div data-testid="send-to-conn-result">{sendToConnResult}</div>
		<div data-testid="connections-by-tag-result">{connectionsByTagResult}</div>
		<div data-testid="quality-result">{qualityResult}</div>
	</section>

	<section>
		<h2>Binary</h2>
		<button data-testid="binary-send-btn" onclick={sendBinary} disabled={status !== 'connected'}>Send Binary</button>
		<div data-testid="binary-result">{binaryResult}</div>
	</section>

	<section>
		<h2>Validation / Defer / Block / Skip</h2>
		<button data-testid="validation-error-btn" onclick={sendInvalidMessage} disabled={status !== 'connected'}>Send Invalid</button>
		<button data-testid="defer-btn" onclick={sendDefer} disabled={status !== 'connected'}>Send Defer</button>
		<button data-testid="block-btn" onclick={sendBlock} disabled={status !== 'connected'}>Send Block</button>
		<button data-testid="skip-btn" onclick={sendSkipTest} disabled={status !== 'connected'}>Send Skip</button>
		<button data-testid="manual-validation-btn" onclick={sendManualValidation} disabled={status !== 'connected'}>Manual Validation</button>
		<button data-testid="always-defer-btn" onclick={sendAlwaysDefer} disabled={status !== 'connected'}>Always Defer</button>
		<div data-testid="validation-error-result">{validationErrorResult}</div>
		<div data-testid="defer-result">{deferResult}</div>
		<div data-testid="block-reply">{blockReply}</div>
		<div data-testid="skip-reply">{skipReply}</div>
		<div data-testid="defer-exhausted-result">{deferExhaustedResult}</div>
	</section>

	<section>
		<h2>Scheduled Extras</h2>
		<button data-testid="start-heartbeat-btn" onclick={startHeartbeat} disabled={status !== 'connected'}>Start Heartbeat</button>
		<button data-testid="trigger-flaky-btn" onclick={triggerFlakyTask} disabled={status !== 'connected'}>Trigger Flaky Task</button>
		<div data-testid="heartbeat-count">{heartbeatCount}</div>
		<div data-testid="flaky-task-result">{flakyTaskResult}</div>
	</section>

	<section>
		<h2>Dead Letter Queue</h2>
		<button data-testid="trigger-always-fail-btn" onclick={triggerAlwaysFail} disabled={status !== 'connected'}>Trigger Always Fail</button>
		<button data-testid="query-dead-letter-btn" onclick={queryDeadLetter} disabled={status !== 'connected'}>Query Dead Letter</button>
		<div data-testid="dead-letter-result">{deadLetterResult}</div>
	</section>

	<section>
		<h2>Broadcast Stream</h2>
		<button data-testid="broadcast-stream-btn" onclick={startBroadcastStream} disabled={status !== 'connected'}>Start Broadcast Stream</button>
		<div data-testid="broadcast-stream-tokens">{broadcastStreamTokens}</div>
	</section>

	<section>
		<h2>Chat Request</h2>
		<button data-testid="chat-info-btn" onclick={requestChatInfo} disabled={!chatSubscribed}>Get Chat Info</button>
		<div data-testid="chat-info-result">{chatInfoResult}</div>
	</section>

	<section>
		<h2>Channel Members / Subscribe Error</h2>
		<button data-testid="get-members-btn" onclick={() => getChannelMembers('chat')} disabled={status !== 'connected'}>Get Chat Members</button>
		<div data-testid="channel-members-result">{channelMembersResult}</div>
		<div data-testid="subscribe-error">{subscribeError}</div>
	</section>

	<section>
		<h2>Stream Cancel</h2>
		<div data-testid="stream-cancel-result">{streamCancelResult}</div>
	</section>

	<section>
		<h2>Sequence</h2>
		<div data-testid="last-seq">{lastSeq}</div>
	</section>

	<section>
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
