<script setup>
import { computed } from 'vue'
import { ViCard } from '@vi-frontend/vision-ui/next'
import { ViNameplate, ViText } from '@vi-frontend/vision-ui'

import { CAPACITY_LABELS, positionLabel, statusColors, statusLabel } from '../statuses'

const props = defineProps({
  lines: { type: Array, default: () => [] },
  floorLabel: { type: String, default: '' },
  statusFilter: { type: String, default: '' },
  typeFilter: { type: String, default: '' },
  selectedPlaceId: { type: String, default: null }
})

const emit = defineEmits(['select'])

// Filters hide non-matching elements rather than rebuilding the list, exactly as before: an
// element survives if any of its slots matches.
const visible = computed(() =>
  props.lines
    .filter((line) => String(line.floorLabel || '') === props.floorLabel)
    .filter((line) => {
      const slots = line.slots || []
      const statusOk = !props.statusFilter || slots.some((slot) => slot.status === props.statusFilter)
      const typeOk = !props.typeFilter || slots.some((slot) => slot.placeType === props.typeFilter)

      return statusOk && typeOk
    })
)
</script>

<template>
  <div v-if="visible.length" class="line-grid">
    <ViCard v-for="line in visible" :key="line.lineId" variant="outlined" padding="12px">
      <div class="slot-line">
        <ViText tag="p" variant="body-Sm-wide">{{ line.name || line.code }}</ViText>
        <ViText tag="span" variant="body-XS-wide" class="muted">
          {{ CAPACITY_LABELS[line.capacity] || line.capacity }}
        </ViText>
      </div>

      <div class="line-slots">
        <!-- A real button, so the slot keeps keyboard focus, Enter/Space activation and a
             native selected state — the property that made this list more accessible than
             the SVG zones it replaced. -->
        <button
          v-for="slot in line.slots"
          :key="slot.placeId"
          type="button"
          class="slot-button"
          :aria-pressed="slot.placeId === selectedPlaceId"
          @click="emit('select', slot.placeId)"
        >
          <span class="slot-line">
            <ViText tag="span" variant="body-Mm-tight">{{ slot.code }}</ViText>
            <ViNameplate size="small" v-bind="statusColors(slot.status)">
              {{ statusLabel(slot.status) }}
            </ViNameplate>
          </span>
          <ViText tag="span" variant="body-XS-wide" class="muted">
            {{ positionLabel(line.capacity, slot.position) }}
            <template v-if="slot.userDisplayName"> · {{ slot.userDisplayName }}</template>
          </ViText>
        </button>
      </div>
    </ViCard>
  </div>

  <ViText v-else tag="p" variant="body-M-wide" class="muted">
    Этаж G{{ floorLabel }}: линий 0.
  </ViText>
</template>
