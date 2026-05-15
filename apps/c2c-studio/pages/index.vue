<template>
  <div class="bg-white overflow-hidden shadow sm:rounded-lg">
    <div class="px-4 py-5 sm:p-6">
      <h2 class="text-lg leading-6 font-medium text-gray-900">Transformation Controls</h2>
      <div class="mt-5">
        <button
          type="button"
          :disabled="!transformationEnabled"
          :class="[
            'inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white',
            transformationEnabled ? 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500' : 'bg-gray-400 cursor-not-allowed'
          ]"
        >
          Run Transformation
        </button>
      </div>
      <p v-if="!transformationEnabled" class="mt-2 text-sm text-red-600">
        Controls are disabled until the BFF health check passes and the orchestrator is live.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject } from 'vue';
import type { Ref } from 'vue';

const transformationEnabled = inject<Ref<boolean>>('transformationEnabled', ref(false));
</script>
