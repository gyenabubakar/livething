<script setup lang="ts">
import { Shader, Aurora } from 'shaders/vue'
</script>

<template>
  <div class="absolute inset-0 mix-blend-screen opacity-30">
    <div class="size-full">
      <Shader>
        <Aurora
          color-a="#cc5200"
          color-b="#ff7a1a"
          color-c="#ffb066"
          :speed="2"
          :intensity="50"
          :curtain-count="3"
          :waviness="35"
          :ray-density="12"
          :height="150"
        />
      </Shader>
    </div>
  </div>
</template>
