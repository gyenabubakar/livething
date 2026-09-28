<template>
  <section aria-label="Translation pipeline" class="my-6 overflow-hidden border border-muted bg-default">
    <header class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
      <UIcon name="i-ph-translate-duotone" class="size-4 text-primary" />
      <span class="font-mono text-xs text-toned">frame translation pipeline</span>
    </header>

    <div class="p-3 sm:p-5">
      <svg viewBox="0 0 820 350" role="img" aria-labelledby="pipeline-title pipeline-description" class="block w-full">
        <title id="pipeline-title">Inbound and outbound frame translation</title>
        <desc id="pipeline-description">Inbound frames pass from a foreign client through the translator into the LiveThing pipeline. Outbound frames pass from LiveThing through the translator back to the foreign client.</desc>

        <defs>
          <marker id="translation-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="#ff8a3d" />
          </marker>
        </defs>

        <g font-family="var(--font-mono)">
          <circle cx="28" cy="32" r="5" fill="#7dd3fc" />
          <text x="42" y="36" fill="#7dd3fc" font-size="13">INBOUND · RUNS FIRST</text>
          <text x="792" y="36" text-anchor="end" fill="#a1a1aa" font-size="12">client → server</text>

          <rect x="20" y="60" width="210" height="102" fill="rgba(14, 116, 144, 0.16)" stroke="#7dd3fc" stroke-opacity="0.55" stroke-width="1.5" />
          <rect x="305" y="60" width="210" height="102" fill="rgba(244, 97, 15, 0.13)" stroke="#ff8a3d" stroke-opacity="0.7" stroke-width="1.5" />
          <rect x="590" y="60" width="210" height="102" fill="rgba(5, 150, 105, 0.14)" stroke="#6ee7b7" stroke-opacity="0.55" stroke-width="1.5" />

          <path d="M230 111 H292" stroke="#ff8a3d" stroke-width="2" marker-end="url(#translation-arrow)" />
          <path d="M515 111 H577" stroke="#ff8a3d" stroke-width="2" marker-end="url(#translation-arrow)" />

          <text x="42" y="96" fill="#bae6fd" font-size="13">foreign client frame</text>
          <text x="42" y="125" fill="#a1a1aa" font-size="12">raw WebSocket string</text>

          <text x="327" y="96" fill="#ffb27e" font-size="11">translator.inbound(raw)</text>
          <text x="327" y="125" fill="#a1a1aa" font-size="12">foreign → LiveThing</text>

          <text x="612" y="96" fill="#a7f3d0" font-size="13">LiveThing pipeline</text>
          <text x="612" y="125" fill="#a1a1aa" font-size="12">ping/pong · parse · handlers</text>

          <line x1="20" y1="207" x2="800" y2="207" stroke="#3f3f46" stroke-width="1" />

          <circle cx="28" cy="242" r="5" fill="#6ee7b7" />
          <text x="42" y="246" fill="#6ee7b7" font-size="13">OUTBOUND · RUNS LAST</text>
          <text x="792" y="246" text-anchor="end" fill="#a1a1aa" font-size="12">server → client</text>

          <rect x="20" y="270" width="210" height="62" fill="rgba(14, 116, 144, 0.16)" stroke="#7dd3fc" stroke-opacity="0.55" stroke-width="1.5" />
          <rect x="305" y="270" width="210" height="62" fill="rgba(244, 97, 15, 0.13)" stroke="#ff8a3d" stroke-opacity="0.7" stroke-width="1.5" />
          <rect x="590" y="270" width="210" height="62" fill="rgba(5, 150, 105, 0.14)" stroke="#6ee7b7" stroke-opacity="0.55" stroke-width="1.5" />

          <path d="M590 301 H528" stroke="#ff8a3d" stroke-width="2" marker-end="url(#translation-arrow)" />
          <path d="M305 301 H243" stroke="#ff8a3d" stroke-width="2" marker-end="url(#translation-arrow)" />

          <text x="42" y="307" fill="#bae6fd" font-size="13">foreign client frame</text>
          <text x="327" y="297" fill="#ffb27e" font-size="11">translator.outbound(</text>
          <text x="327" y="316" fill="#ffb27e" font-size="11">outgoing)</text>
          <text x="612" y="307" fill="#a7f3d0" font-size="13">LiveThing final string</text>
        </g>
      </svg>
    </div>
  </section>
</template>
