<script lang="ts">
	const features = [
		'channel-dynamic',
		'channel-static',
		'ctx-channels',
		'ctx-kv',
		'ctx-meta',
		'ctx-quality',
		'ctx-send',
		'ctx-sql',
		'ctx-tags',
		'dedup',
		'errors-control-flow',
		'errors-factory',
		'keepalive',
		'hibernation',
		'incoming',
		'intercept',
		'lifecycle-hooks',
		'plugins',
		'protocol-pings',
		'replay',
		'replay-custom',
		'replay-snapshot',
		'request',
		'scheduled',
		'sequence',
		'stream-basic',
		'stream-broadcast',
		'stream-nudges',
	];
</script>

<h1>wskit e2e feature index</h1>
<ul>
	{#each features as feature}
		<li><a href={`/${feature}`} data-testid={`link-${feature}`}>{feature}</a></li>
	{/each}
</ul>
