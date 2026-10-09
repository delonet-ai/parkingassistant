<script setup>
import { computed } from 'vue'
import { ViButton, ViModal, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { closeHistory, state } from '../store'

// One card per subject, built from the five streams the API returns for a place or an
// employee. Empty streams are dropped rather than rendered as empty tables — a place with no
// movements should not make the operator scroll past a header to find out.
const STREAMS = [
  {
    key: 'permanentAssignments',
    title: 'Постоянные закрепления',
    headers: ['С', 'По', 'Кто', 'Комментарий'],
    row: (item) => [
      item.dateFrom || '—',
      item.dateTo || 'бессрочно',
      item.user?.displayName || item.parkingPlace?.code || '—',
      item.notes || '—'
    ]
  },
  {
    key: 'releases',
    title: 'Отдачи',
    headers: ['С', 'По', 'Состояние', 'Кем создано'],
    row: (item) => [item.dateFrom || '—', item.dateTo || '—', item.status || '—', item.createdVia || '—']
  },
  {
    key: 'reservations',
    title: 'Назначения',
    headers: ['Дата', 'Кто', 'Источник', 'Состояние'],
    row: (item) => [
      item.reservationDate || '—',
      item.user?.displayName || item.parkingPlace?.code || '—',
      item.source || '—',
      item.status || '—'
    ]
  },
  {
    key: 'movements',
    title: 'Перемещения',
    headers: ['Дата', 'Откуда', 'Куда', 'Тип'],
    row: (item) => [
      item.movementDate || '—',
      item.fromParkingPlace?.code || '—',
      item.toParkingPlace?.code || '—',
      item.movementType || '—'
    ]
  },
  {
    key: 'auditLogs',
    title: 'Аудит',
    headers: ['Когда', 'Действие', 'Сущность', 'Кто'],
    row: (item) => [
      String(item.createdAt || '').slice(0, 19).replace('T', ' '),
      item.action || '—',
      item.entityType || '—',
      item.actorService || item.actorUser?.displayName || '—'
    ]
  }
]

const subject = computed(() => {
  const data = state.history?.data

  if (!data) {
    return null
  }

  return data.place?.code || data.employee?.displayName || data.user?.displayName || ''
})

const sections = computed(() => {
  const history = state.history?.data?.history || {}

  return STREAMS.map((stream) => ({
    ...stream,
    items: Array.isArray(history[stream.key]) ? history[stream.key] : []
  })).filter((stream) => stream.items.length)
})
</script>

<template>
  <!-- `use-model` is required: without it ViModal ignores isOpened and renders open, which
       put an empty history card over the catalog on every page load. -->
  <ViModal
    use-model
    :is-opened="Boolean(state.history)"
    :title="`История · ${subject || '…'}`"
    width="820px"
    has-close-button
    @update:is-opened="closeHistory"
  >
    <ViText v-if="state.history?.error" tag="p" variant="body-M-wide">
      {{ state.history.error }}
    </ViText>

    <ViText v-else-if="!state.history?.data" tag="p" variant="body-M-wide" class="muted">
      Загрузка…
    </ViText>

    <template v-else>
      <div v-for="section in sections" :key="section.key" class="stack">
        <ViText tag="h4" variant="title-h6" class="section-gap">{{ section.title }}</ViText>
        <div class="table-scroll">
          <ViTableSimple
            :headers="section.headers.map((text) => ({ text }))"
            :rows="section.items.map((item) => section.row(item).map((text) => ({ text: String(text) })))"
          />
        </div>
      </div>

      <ViText v-if="!sections.length" tag="p" variant="body-M-wide" class="muted">
        По этому объекту событий пока нет.
      </ViText>

      <ViButton variant="outlined" color="secondary" class="section-gap" @click="closeHistory">
        Закрыть
      </ViButton>
    </template>
  </ViModal>
</template>
