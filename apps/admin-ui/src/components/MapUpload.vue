<script setup>
import { ref } from 'vue'
import { ViButton, ViText } from '@vi-frontend/vision-ui'

import { loadDay, notify, state } from '../store'

const busy = ref(null)
const inputs = ref({})

function formatMoment(value) {
  return String(value || '').slice(0, 19).replace('T', ' ')
}

async function upload(map, event) {
  const file = event.target.files?.[0]

  if (!file) {
    return
  }

  busy.value = map.code

  try {
    // multipart/form-data, not JSON: the API stores only metadata, so this app's own server
    // writes the file into the shared storage and tells the API where it landed.
    const form = new FormData()
    form.append('mapCode', map.code)
    form.append('mapTitle', map.metadata?.title || map.title)
    form.append('floorLabel', map.floorLabel)
    form.append('mapFile', file)

    const response = await fetch('/api/admin/map-backgrounds', { method: 'POST', body: form })
    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      notify('error', (payload && payload.error) || `Не удалось загрузить подложку (${response.status})`)
      return
    }

    notify('success', `Подложка ${map.title} обновлена.`)
    await loadDay()
  } finally {
    busy.value = null
    event.target.value = ''
  }
}
</script>

<template>
  <div class="jobs-grid">
    <div v-for="map in state.maps" :key="map.code" class="job-tile">
      <ViText tag="p" variant="body-Sm-wide">Этаж {{ map.title }}</ViText>
      <ViText tag="p" variant="body-XS-wide" class="muted">
        <template v-if="map.metadata">
          версия {{ map.metadata.version }} ·
          {{ String(map.metadata.sourceChecksum || '').slice(0, 12) }} ·
          {{ formatMoment(map.metadata.updatedAt) }}
        </template>
        <template v-else>подложка не загружена</template>
      </ViText>

      <img
        v-if="map.metadata"
        class="plan-thumb"
        :src="`/maps/parking-${map.code}.png`"
        :alt="`План этажа ${map.title}`"
        onerror="this.style.display='none'"
      />

      <input
        :ref="(element) => (inputs[map.code] = element)"
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.pdf"
        hidden
        @change="upload(map, $event)"
      />
      <ViButton
        size="small"
        variant="outlined"
        color="secondary"
        :loading="busy === map.code"
        @click="inputs[map.code]?.click()"
      >
        Заменить подложку
      </ViButton>
    </div>
  </div>
</template>
