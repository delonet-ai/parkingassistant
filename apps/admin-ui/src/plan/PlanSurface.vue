<script setup>
// The one surface both plan screens draw on: a single <svg> whose viewBox is the plan image's
// natural pixel size, the image as its background, and every layer (the default slot) in
// those same image pixels — so markup never drifts with zoom or window size.
//
// Pan and zoom are a transform on one <g>, not a library: wheel zooms at the cursor, dragging
// empty space (or anything with Space held, or the middle button) pans, `fit()` and
// `zoomToBox()` animate. A layer that wants a pointer gesture of its own listens to `press`
// and fills in `payload.drag` ({ begin, move(event, point), end, click }) or `payload.click`;
// anything left unclaimed pans. A native `click` that ends a drag is swallowed, so layers can
// use plain @click for "select".
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ViButton, ViText } from '@vi-frontend/vision-ui'

const props = defineProps({
  imageSrc: { type: String, default: null },
  imageWidth: { type: Number, default: null },
  imageHeight: { type: Number, default: null },
  // A CSS height for the stage; without one it keeps the plan's aspect ratio.
  height: { type: String, default: '' },
  label: { type: String, default: 'План этажа' }
})

const emit = defineEmits(['image-size', 'press', 'pointer-move', 'dblclick'])

const MIN_SCALE = 0.4
const MAX_SCALE = 40
const DRAG_THRESHOLD = 4

const stage = ref(null)
const svg = ref(null)
const view = reactive({ s: 1, tx: 0, ty: 0 })
const box = reactive({ width: 0, height: 0 })
const natural = reactive({ width: null, height: null, failed: false })
const panning = ref(false)

const width = computed(() => props.imageWidth || natural.width || 0)
const height = computed(() => props.imageHeight || natural.height || 0)
const ready = computed(() => width.value > 0 && height.value > 0)

const stageStyle = computed(() =>
  props.height
    ? { height: props.height }
    : { aspectRatio: ready.value ? `${width.value} / ${height.value}` : '3 / 2' }
)

const transform = computed(() => `translate(${view.tx} ${view.ty}) scale(${view.s})`)

/** Screen px per image px at scale 1 (the svg letterboxes the plan with `meet`). */
function rootScale() {
  const rect = svg.value?.getBoundingClientRect?.()
  const k = rect ? Math.min(rect.width / width.value, rect.height / height.value) : 0

  return Number.isFinite(k) && k > 0 ? k : 1
}

const rootScaleReactive = computed(() => {
  const k = Math.min(box.width / width.value, box.height / height.value)

  return Number.isFinite(k) && k > 0 ? k : 1
})

/** Image pixels per screen pixel right now — for handles and strokes that must stay a fixed size. */
const px = computed(() => 1 / (rootScaleReactive.value * view.s))

function toRoot(clientX, clientY) {
  const rect = svg.value?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 }
  const k = rootScale()
  const ox = (rect.width - width.value * k) / 2
  const oy = (rect.height - height.value * k) / 2

  return [(clientX - rect.left - (Number.isFinite(ox) ? ox : 0)) / k, (clientY - rect.top - (Number.isFinite(oy) ? oy : 0)) / k]
}

function toWorld(clientX, clientY) {
  const [x, y] = toRoot(clientX, clientY)

  return [(x - view.tx) / view.s, (y - view.ty) / view.s]
}

function loadNatural() {
  natural.failed = false
  if (!props.imageSrc || (props.imageWidth && props.imageHeight) || typeof Image === 'undefined') {
    return
  }

  const image = new Image()
  const src = props.imageSrc
  image.onload = () => {
    if (src !== props.imageSrc) return
    natural.width = image.naturalWidth
    natural.height = image.naturalHeight
    emit('image-size', { width: image.naturalWidth, height: image.naturalHeight })
  }
  image.onerror = () => {
    natural.failed = true
  }
  image.src = src
}

watch(() => [props.imageSrc, props.imageWidth, props.imageHeight], loadNatural, { immediate: true })

// ---- zoom ----
let animation = null
const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (fn(Date.now() + 1e6), null))
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function cancelAnimation() {
  if (animation !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animation)
  animation = null
}

function zoomAt(rootPoint, factor) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s * factor))
  const f = next / view.s

  view.tx = rootPoint[0] - (rootPoint[0] - view.tx) * f
  view.ty = rootPoint[1] - (rootPoint[1] - view.ty) * f
  view.s = next
}

function stageCentreRoot() {
  const rect = svg.value?.getBoundingClientRect?.()

  return rect ? toRoot(rect.left + rect.width / 2, rect.top + rect.height / 2) : [width.value / 2, height.value / 2]
}

function animateTo(target) {
  cancelAnimation()
  const from = { ...view }
  const centre = stageCentreRoot()
  const t0 = now()

  const step = (time) => {
    const k = Math.min(1, (time - t0) / 280)
    const e = 1 - Math.pow(1 - k, 3)
    // Log-space interpolation of the scale reads as an even zoom.
    const s = Math.exp(Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * e)
    const c0x = (centre[0] - from.tx) / from.s
    const c0y = (centre[1] - from.ty) / from.s
    const c1x = (centre[0] - target.tx) / target.s
    const c1y = (centre[1] - target.ty) / target.s
    const cx = c0x + (c1x - c0x) * e
    const cy = c0y + (c1y - c0y) * e

    view.s = s
    view.tx = centre[0] - cx * s
    view.ty = centre[1] - cy * s
    animation = k < 1 ? raf(step) : null
  }

  animation = raf(step)
}

function fit() {
  animateTo({ s: 1, tx: 0, ty: 0 })
}

/** Bring an image-pixel box { x0, y0, x1, y1 } into view, never closer than `minSide`. */
function zoomToBox(target, minSide = 500) {
  const rect = svg.value?.getBoundingClientRect?.()
  if (!rect || !Number.isFinite(target.x0)) return

  const [ax, ay] = toRoot(rect.left, rect.top)
  const [bx, by] = toRoot(rect.right, rect.bottom)
  const bw = Math.max(target.x1 - target.x0, minSide)
  const bh = Math.max(target.y1 - target.y0, minSide * 0.7)
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((bx - ax) / (bw * 1.3), (by - ay) / (bh * 1.3))))
  const cx = (target.x0 + target.x1) / 2
  const cy = (target.y0 + target.y1) / 2

  animateTo({ s, tx: (ax + bx) / 2 - cx * s, ty: (ay + by) / 2 - cy * s })
}

function zoomButton(factor) {
  cancelAnimation()
  zoomAt(stageCentreRoot(), factor)
}

function onWheel(event) {
  cancelAnimation()
  const dy = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
  const clamped = Math.max(-200, Math.min(200, dy))

  zoomAt(toRoot(event.clientX, event.clientY), Math.exp(-clamped * (event.ctrlKey ? 0.01 : 0.0018)))
}

// ---- pointer ----
let drag = null
let swallowClick = false
let spaceDown = false

function stopListening() {
  window.removeEventListener('pointermove', onWindowMove)
  window.removeEventListener('pointerup', onWindowUp)
  window.removeEventListener('pointercancel', onWindowCancel)
}

function startDrag(event, handlers) {
  drag = { sx: event.clientX, sy: event.clientY, moved: false, ...handlers }
  window.addEventListener('pointermove', onWindowMove)
  window.addEventListener('pointerup', onWindowUp)
  window.addEventListener('pointercancel', onWindowCancel)
}

function startPan(event, click = null) {
  const t0 = { tx: view.tx, ty: view.ty }
  const k = rootScale()

  startDrag(event, {
    begin() {
      panning.value = true
    },
    move(ev) {
      view.tx = t0.tx + (ev.clientX - event.clientX) / k
      view.ty = t0.ty + (ev.clientY - event.clientY) / k
    },
    end() {
      panning.value = false
    },
    click
  })
}

function onPointerDown(event) {
  if (event.button === 2 || drag) return
  cancelAnimation()

  if (event.button === 1 || spaceDown) {
    event.preventDefault()
    startPan(event)
    return
  }

  const payload = { event, point: toWorld(event.clientX, event.clientY), target: event.target, drag: null, click: null }
  emit('press', payload)

  if (payload.drag) startDrag(event, payload.drag)
  else startPan(event, payload.click)
}

function onWindowMove(event) {
  if (!drag) return
  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) < DRAG_THRESHOLD) return
    drag.moved = true
    drag.begin?.()
  }
  drag.move?.(event, toWorld(event.clientX, event.clientY))
}

function onWindowUp(event) {
  const finished = drag
  drag = null
  stopListening()
  if (!finished) return

  if (finished.moved) {
    finished.end?.(event)
    swallowClick = true
    setTimeout(() => {
      swallowClick = false
    }, 0)
  } else {
    finished.click?.(event, toWorld(event.clientX, event.clientY))
  }
}

function onWindowCancel() {
  const finished = drag
  drag = null
  stopListening()
  if (finished?.moved) finished.end?.()
}

function onClickCapture(event) {
  if (swallowClick) {
    event.stopPropagation()
    event.preventDefault()
  }
}

function onPointerMove(event) {
  if (!drag) emit('pointer-move', { event, point: toWorld(event.clientX, event.clientY) })
}

function onDblClick(event) {
  emit('dblclick', { event, point: toWorld(event.clientX, event.clientY) })
}

const isTyping = (target) => /INPUT|TEXTAREA|SELECT/.test(target?.tagName || '') || target?.isContentEditable

function onKeyDown(event) {
  if (event.code === 'Space' && !isTyping(event.target) && stage.value?.matches?.(':hover')) {
    spaceDown = true
    event.preventDefault()
  }
}

function onKeyUp(event) {
  if (event.code === 'Space') spaceDown = false
}

let observer = null

function measure() {
  const rect = svg.value?.getBoundingClientRect?.()
  if (rect) {
    box.width = rect.width
    box.height = rect.height
  }
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'function' && stage.value) {
    observer = new ResizeObserver(measure)
    observer.observe(stage.value)
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})

watch(ready, () => setTimeout(measure, 0))

onBeforeUnmount(() => {
  cancelAnimation()
  stopListening()
  observer?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})

defineExpose({ fit, zoomToBox, toWorld, px })
</script>

<template>
  <div ref="stage" class="plan-surface" :style="stageStyle">
    <svg
      v-if="ready"
      ref="svg"
      class="plan-surface__svg"
      :class="{ 'plan-surface__svg--panning': panning }"
      :viewBox="`0 0 ${width} ${height}`"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      :aria-label="label"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @wheel.prevent="onWheel"
      @click.capture="onClickCapture"
      @dblclick="onDblClick"
    >
      <g :transform="transform">
        <image
          v-if="imageSrc"
          :href="imageSrc"
          x="0"
          y="0"
          :width="width"
          :height="height"
          preserveAspectRatio="none"
        />
        <slot :px="px" :scale="view.s" />
      </g>
    </svg>

    <div v-else class="plan-surface__empty">
      <ViText tag="p" variant="body-S-wide" class="muted">
        {{ natural.failed ? 'Не удалось загрузить изображение плана.' : 'Загрузка плана…' }}
      </ViText>
    </div>

    <div class="plan-surface__overlay">
      <slot name="overlay" />
    </div>

    <div v-if="ready" class="plan-surface__zoom">
      <ViButton variant="outlined" color="secondary" size="small" aria-label="Приблизить" @click="zoomButton(1.4)">+</ViButton>
      <ViButton variant="outlined" color="secondary" size="small" aria-label="Отдалить" @click="zoomButton(1 / 1.4)">−</ViButton>
      <ViButton variant="outlined" color="secondary" size="small" @click="fit">Вписать</ViButton>
    </div>
  </div>
</template>

<style scoped>
.plan-surface {
  position: relative;
  width: 100%;
  max-height: 75vh;
  overflow: hidden;
  border: 1px solid var(--vi-color-gray-200);
  border-radius: var(--vi-radius-m);
  background: var(--vi-color-gray-100);
}

.plan-surface__svg {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.plan-surface__svg--panning {
  cursor: grabbing;
}

.plan-surface__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 160px;
}

.plan-surface__overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  pointer-events: none;
}

.plan-surface__overlay > :deep(*) {
  pointer-events: auto;
}

.plan-surface__zoom {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 4px;
}
</style>
