<template>
  <div class="min-h-screen bg-gray-50">
    <header class="bg-white shadow">
      <div class="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
        <h1 class="text-3xl font-bold text-gray-900">c2c Transformation Studio</h1>
        <div v-if="hasBffUrl" class="flex items-center space-x-4">
          <span v-if="healthStatus === 'ok'" class="text-green-600 font-semibold">BFF: OK</span>
          <span v-else class="text-red-600 font-semibold">BFF: Unavailable</span>
          
          <span v-if="modeStatus" class="text-gray-600">
            Mode: {{ modeStatus.mode }} (Upstream: {{ modeStatus.upstream_reachable ? 'Reachable' : 'Unreachable' }})
          </span>
        </div>
      </div>
    </header>
    <main>
      <div class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div v-if="!hasBffUrl" class="bg-red-50 border-l-4 border-red-400 p-4 mb-4">
          <div class="flex">
            <div class="ml-3">
              <p class="text-sm text-red-700">
                Blocking Configuration State: NUXT_PUBLIC_C2C_BFF_BASE_URL is not set.
              </p>
            </div>
          </div>
        </div>
        <NuxtPage v-else />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { useC2cApi } from '~/composables/useC2cApi';
import { ref, onMounted, computed, provide } from 'vue';
import type { ApiModeResponse } from '~/types/api';
import { useRuntimeConfig } from '#app';

const config = useRuntimeConfig();
const hasBffUrl = !!config.public.c2cBffBaseUrl;

const { getHealth, getMode } = useC2cApi();

const healthStatus = ref<string | null>(null);
const modeStatus = ref<ApiModeResponse | null>(null);

provide('bffAvailable', computed(() => healthStatus.value === 'ok'));

onMounted(async () => {
  if (!hasBffUrl) return;

  const healthResult = await getHealth();
  if (healthResult.success && healthResult.data) {
    healthStatus.value = healthResult.data.status;
  } else {
    healthStatus.value = 'error';
  }
  
  if (healthStatus.value === 'ok') {
    const modeResult = await getMode();
    if (modeResult.success && modeResult.data) {
      modeStatus.value = modeResult.data;
    }
  }
});
</script>
