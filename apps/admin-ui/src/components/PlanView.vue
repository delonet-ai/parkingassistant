<script setup>
// The Day tab's plan: every marked place filled with its status colour, the code on top, a
// thin frame around each multi-slot line. Statuses are the API's (`/admin/place-lines`); the
// plan only draws them, exactly as PlaceLines lists them. A status filter dims what does not
// match instead of hiding it — the operator still has to see where the other places are.
import { computed, ref } from 'vue'
import { ViAlert, ViText } from '@vi-frontend/vision-ui'

import PlanSurface from '../plan/PlanSurface.vue'
import { bbox, centroid, cleanPolygon, hull, labelFontSize, pointsAttr, round1 } from '../plan/geometry'
import { positionLabel, statusColors, statusLabel } from '../statuses'

const props = defineProps({
  lines: { type: Array, default: () => [] },
  markup: { type: Object, default: null },
  planSrc: { type: String, default: null },
  statusFilter: { type: String, default: '' },
  selectedPlaceId: { type: String, default: null }
})

const emit = defineEmits(['select'])

const surface = ref(null)

const slotIndex = computed(() => {
  const index = new Map()

  for (const line of props.lines) {
    for (const slot of line.slots || []) {
      index.set(slot.placeId, { slot, line })
    }
  }

  return index
})

const matches = (slot) => !props.statusFilter || slot.status === props.statusFilter

/** Marked places that exist in the inventory; a polygon for an unknown id is not drawn. */
const places = computed(() => {
  const result = []

  for (const [placeId, value] of Object.entries(props.markup?.places || {})) {
    const info = slotIndex.value.get(placeId)
    const polygon = cleanPolygon(value?.polygon)

    if (!info || !polygon) continue

    const { slot, line } = info
    const colors = statusColors(slot.status)
    const [cx, cy] = centroid(polygon)
    const position = positionLabel(line.capacity, slot.position)

    result.push({
      placeId,
      code: slot.code,
      points: pointsAttr(polygon),
      fill: colors.backgroundColor,
      stroke: colors.textColor,
      label: { x: round1(cx), y: round1(cy), size: labelFontSize(polygon, slot.code) },
      dim: !matches(slot),
      selected: placeId === props.selectedPlaceId,
      title: [
        `${slot.code} · ${statusLabel(slot.status)}`,
        position ? `${line.name || line.code} · ${position}` : line.name || line.code,
        slot.userDisplayName ? `Стоит: ${slot.userDisplayName}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      polygon
    })
  }

  return result
})

const outlines = computed(() => {
  const byPlace = new Map(places.value.map((place) => [place.placeId, place]))
  const result = []

  for (const line of props.lines) {
    if ((line.slots || []).length < 2) continue
    const marked = line.slots.map((slot) => byPlace.get(slot.placeId)).filter(Boolean)
    if (marked.length < 2) continue

    result.push({
      lineId: line.lineId,
      points: pointsAttr(hull(marked.flatMap((place) => place.polygon))),
      dim: marked.every((place) => place.dim)
    })
  }

  return result
})

const hasMarkup = computed(() => places.value.length > 0)
const width = computed(() => props.markup?.imageWidth || null)
const height = computed(() => props.markup?.imageHeight || null)

function select(placeId) {
  emit('select', placeId)
}

/** Centre the plan on a place, e.g. after it was chosen in the list. */
function focusPlace(placeId) {
  const place = places.value.find((candidate) => candidate.placeId === placeId)
  if (place) surface.value?.zoomToBox(bbox([place.polygon]), 800)
}

defineExpose({ focusPlace })
</script>

<template>
  <div class="plan-view">
    <ViAlert v-if="markup?.planChanged" type="warning" title="Подложка плана заменена">
      Изображение плана загрузили заново уже после разметки. Места могут не совпадать с рисунком —
      проверьте разметку во вкладке «Места».
    </ViAlert>

    <ViText v-if="!hasMarkup" tag="p" variant="body-S-wide" class="muted plan-view__hint">
      План ещё не размечен — разметьте его во вкладке «Места».
    </ViText>

    <PlanSurface
      v-if="planSrc || hasMarkup"
      ref="surface"
      :image-src="planSrc"
      :image-width="width"
      :image-height="height"
      label="План этажа со статусами мест"
    >
      <g class="plan-view__places">
        <polygon
          v-for="place in places"
          :key="place.placeId"
          class="plan-view__place"
          :class="{ 'plan-view__place--dim': place.dim, 'plan-view__place--selected': place.selected }"
          :data-pid="place.placeId"
          :points="place.points"
          :style="{ fill: place.fill, stroke: place.stroke }"
          tabindex="0"
          role="button"
          :aria-label="place.title.replace(/\n/g, ', ')"
          :aria-pressed="place.selected"
          @click="select(place.placeId)"
          @keydown.enter.prevent="select(place.placeId)"
          @keydown.space.prevent="select(place.placeId)"
        >
          <title>{{ place.title }}</title>
        </polygon>
      </g>
      <g class="plan-view__outlines">
        <polygon
          v-for="outline in outlines"
          :key="outline.lineId"
          class="plan-view__outline"
          :class="{ 'plan-view__outline--dim': outline.dim }"
          :points="outline.points"
        />
      </g>
      <g class="plan-view__labels">
        <text
          v-for="place in places"
          :key="place.placeId"
          class="plan-view__label"
          :class="{ 'plan-view__label--dim': place.dim }"
          :x="place.label.x"
          :y="place.label.y"
          :font-size="place.label.size"
        >
          {{ place.code }}
        </text>
      </g>
    </PlanSurface>

    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      Подложка этажа не загружена — её загружают во вкладке «Места».
    </ViText>
  </div>
</template>

<style scoped>
.plan-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 16px;
}

.plan-view__place {
  fill-opacity: 0.75;
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
  cursor: pointer;
  outline: none;
}

.plan-view__place:hover,
.plan-view__place:focus-visible {
  stroke-width: 2.5;
}

.plan-view__place--selected {
  stroke: var(--vi-color-red-500) !important;
  stroke-width: 4;
  fill-opacity: 0.9;
}

.plan-view__place--dim {
  opacity: 0.2;
}

.plan-view__outline {
  fill: none;
  stroke: var(--vi-color-gray-1000);
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}

.plan-view__outline--dim {
  opacity: 0.2;
}

.plan-view__label {
  font-family: var(--vi-font-family);
  font-weight: 700;
  fill: var(--vi-color-gray-1000);
  paint-order: stroke;
  stroke: var(--vi-color-white);
  stroke-width: 3px;
  stroke-linejoin: round;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.plan-view__label--dim {
  opacity: 0.25;
}
</style>
