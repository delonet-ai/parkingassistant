<script setup>
import { computed, ref } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViButton, ViInput, ViNameplate, ViSelect, ViSpoiler, ViText } from '@vi-frontend/vision-ui'

import { sourceLabel, statusColors, statusLabel } from '../statuses'
import { state, submit } from '../store'

// Which operations a place offers is decided here only in the sense of *showing* them; the
// API is still the one that refuses an impossible one, and its message is what the operator
// sees. Nothing below re-implements a parking rule.
const selected = computed(() => {
  if (!state.selectedPlaceId) {
    return null
  }

  const place = state.places.find((item) => item.id === state.selectedPlaceId)
  if (!place) {
    return null
  }

  const dashboard = state.dashboard || {}
  const slot = state.lines
    .flatMap((line) => line.slots || [])
    .find((item) => item.placeId === place.id)

  return {
    place,
    // The status is the API's, the same value the slot in the list shows — so the drawer and
    // the slot can never disagree about one place.
    status: slot ? slot.status : null,
    release: (dashboard.releasedPlaces || []).find((item) => item.parkingPlace.id === place.id) || null,
    reservation: (dashboard.reservations || []).find((item) => item.parkingPlace.id === place.id) || null,
    guestRequest:
      (dashboard.guestRequests || []).find(
        (request) => request.assignedReservation?.parkingPlace?.id === place.id
      ) || null,
    occupancy: state.occupancy.find((item) => item.parkingPlace.id === place.id) || null
  }
})

const employeeOptions = computed(() =>
  state.employees.map((employee) => ({
    value: employee.id,
    text: [
      employee.displayName,
      employee.department || null,
      employee.permanentPlace ? `место ${employee.permanentPlace.code}` : 'без места'
    ]
      .filter(Boolean)
      .join(' · ')
  }))
)

const hostOptions = computed(() =>
  state.employees.map((employee) => ({ value: employee.id, text: employee.displayName }))
)

// The slot statuses the API gives a place in the day's free supply and not yet taken:
// released by its owner, without a permanent owner, or in the rotatable guest pool.
const OPEN_STATUSES = new Set(['released', 'free', 'rotatable'])

// Where a reservation may move: the day's open slots, by the API's own status. The list is
// a convenience, not the rule — the API still refuses an impossible target by name.
const moveOptions = computed(() =>
  state.lines
    .flatMap((line) => line.slots || [])
    .filter((slot) => OPEN_STATUSES.has(slot.status) && slot.placeId !== selected.value?.place.id)
    .map((slot) => ({
      value: slot.placeId,
      text: [slot.code, statusLabel(slot.status)].filter(Boolean).join(' · ')
    }))
)

const canAssign = computed(
  () => Boolean(selected.value) && !selected.value.reservation && OPEN_STATUSES.has(selected.value.status)
)

const releaseNotes = ref('')
const assignUserId = ref(null)
const assignReason = ref('')
const moveToPlaceId = ref(null)
const moveReason = ref('')
const guest = ref({ hostUserId: null, guestName: '', guestPhone: '', vehiclePlateNumber: '' })
const busy = ref(false)

async function run(action) {
  busy.value = true
  try {
    await action()
  } finally {
    busy.value = false
  }
}

const release = () =>
  run(async () => {
    await submit(
      '/admin/place-releases',
      {
        parkingPlaceId: selected.value.place.id,
        dateFrom: state.date,
        dateTo: state.date,
        notes: releaseNotes.value || null
      },
      'Место отдано на выбранный день.'
    )
    releaseNotes.value = ''
  })

const assign = () =>
  run(async () => {
    await submit(
      '/admin/reservations/manual',
      {
        userId: assignUserId.value,
        parkingPlaceId: selected.value.place.id,
        reservationDate: state.date,
        reason: assignReason.value || null
      },
      'Место назначено.'
    )
    assignUserId.value = null
    assignReason.value = ''
  })

const cancelReservation = () =>
  run(() =>
    submit(
      '/admin/reservations/cancel',
      { reservationId: selected.value.reservation.id },
      'Назначение отменено.'
    )
  )

const moveReservation = () =>
  run(async () => {
    const result = await submit(
      '/admin/reservations/move',
      {
        reservationId: selected.value.reservation.id,
        toParkingPlaceId: moveToPlaceId.value,
        reason: moveReason.value || null
      },
      'Назначение переведено на другое место.'
    )
    // A refused move keeps what the operator picked, so they can read the reason and retry.
    if (result.ok) {
      moveToPlaceId.value = null
      moveReason.value = ''
    }
  })

const cancelRelease = () =>
  run(() =>
    submit(
      '/admin/place-releases/cancel',
      { releaseId: selected.value.release.releaseId },
      'Место возвращено владельцу.'
    )
  )

const createGuest = () =>
  run(async () => {
    await submit(
      '/admin/guest-parking-requests',
      { ...guest.value, requestDate: state.date },
      'Гостевая заявка создана.'
    )
    guest.value = { hostUserId: null, guestName: '', guestPhone: '', vehiclePlateNumber: '' }
  })
</script>

<template>
  <ViCard variant="outlined">
    <ViCardContent>
      <template v-if="!selected">
        <ViText tag="h3" variant="title-h5">Место не выбрано</ViText>
        <ViText tag="p" variant="body-M-wide" class="muted">
          Выберите место в списке элементов, чтобы открыть операционную карточку.
        </ViText>
      </template>

      <template v-else>
        <div class="slot-line">
          <div>
            <ViText tag="h3" variant="title-h5">
            {{ selected.place.code }}
            <template v-if="selected.place.title && selected.place.title !== selected.place.code">
              · {{ selected.place.title }}
            </template>
          </ViText>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              {{ selected.place.floorLabel ? `этаж ${selected.place.floorLabel}` : 'без этажа' }} ·
              {{ selected.place.placeType }} ·
              {{ selected.place.lineGroup ? `линия ${selected.place.lineGroup.code}` : 'без линии' }}
            </ViText>
          </div>
          <ViNameplate v-bind="statusColors(selected.status)">
            {{ statusLabel(selected.status) }}
          </ViNameplate>
        </div>

        <div class="kpi-grid" style="margin-top: 12px">
          <div>
            <ViText tag="p" variant="body-S-wide" class="muted">Владелец</ViText>
            <ViText tag="p" variant="body-M-wide">
              {{ selected.place.permanentOwner ? selected.place.permanentOwner.displayName : '—' }}
            </ViText>
          </div>
          <div>
            <ViText tag="p" variant="body-S-wide" class="muted">Назначение</ViText>
            <ViText tag="p" variant="body-M-wide">
              <template v-if="selected.reservation">
                {{ sourceLabel(selected.reservation.source) }} ·
                {{
                  selected.reservation.user?.displayName || selected.guestRequest?.guestName || 'гость'
                }}
              </template>
              <template v-else>—</template>
            </ViText>
          </div>
          <div>
            <ViText tag="p" variant="body-S-wide" class="muted">Отдача</ViText>
            <ViText tag="p" variant="body-M-wide">
              {{ selected.release ? selected.release.owner.displayName : '—' }}
            </ViText>
          </div>
          <div>
            <ViText tag="p" variant="body-S-wide" class="muted">Позиция</ViText>
            <ViText tag="p" variant="body-M-wide">
              {{ selected.occupancy ? `позиция ${selected.occupancy.position}` : '—' }}
            </ViText>
          </div>
        </div>

        <ViText tag="h4" variant="title-h6" class="section-gap">Операции по месту</ViText>

        <div class="stack">
          <template v-if="selected.place.permanentOwner">
            <ViInput
              v-model:value="releaseNotes"
              label="Комментарий к отдаче"
              label-type="static"
              clearable
            />
            <ViButton color="primary" :loading="busy" @click="release">
              Отдать на {{ state.date }}
            </ViButton>
          </template>
          <ViText v-else tag="p" variant="body-S-wide" class="muted">
            У места нет постоянного владельца, отдача недоступна.
          </ViText>

          <template v-if="canAssign">
            <ViSelect
              :value="assignUserId"
              :options="employeeOptions"
              label="Назначить сотрудника"
              label-type="static"
              text-field-name="text"
              value-field-name="value"
              track-by-value
              has-search
              clearable
              @update:value="assignUserId = $event"
            />
            <ViInput v-model:value="assignReason" label="Причина" label-type="static" clearable />
            <ViButton color="primary" :loading="busy" :disabled="!assignUserId" @click="assign">
              Назначить
            </ViButton>
          </template>
          <ViText v-else-if="!selected.reservation" tag="p" variant="body-S-wide" class="muted">
            Ручное назначение доступно только для свободного места: отданного владельцем или без
            постоянного владельца.
          </ViText>

          <ViButton
            v-if="selected.reservation"
            color="secondary"
            variant="outlined"
            :loading="busy"
            @click="cancelReservation"
          >
            Отменить назначение
          </ViButton>

          <template v-if="selected.reservation">
            <ViText tag="h4" variant="title-h6" class="section-gap">Перевести на другое место</ViText>
            <ViSelect
              :value="moveToPlaceId"
              :options="moveOptions"
              label="Новое место"
              label-type="static"
              text-field-name="text"
              value-field-name="value"
              track-by-value
              has-search
              clearable
              @update:value="moveToPlaceId = $event"
            />
            <ViInput v-model:value="moveReason" label="Причина перевода" label-type="static" clearable />
            <ViButton color="primary" :loading="busy" :disabled="!moveToPlaceId" @click="moveReservation">
              Перевести
            </ViButton>
            <ViText v-if="!moveOptions.length" tag="p" variant="body-XS-wide" class="muted">
              На {{ state.date }} нет свободных мест, переводить некуда.
            </ViText>
          </template>

          <template v-if="selected.release">
            <ViButton
              color="secondary"
              variant="outlined"
              :loading="busy"
              :disabled="Boolean(selected.reservation)"
              @click="cancelRelease"
            >
              Вернуть место владельцу
            </ViButton>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              {{
                selected.reservation
                  ? 'Сначала отмените назначение — место уже отдано кому-то на этот день.'
                  : 'Отменяет отдачу: место снова закреплено за владельцем.'
              }}
            </ViText>
          </template>
        </div>

        <ViSpoiler title="Создать гостевую заявку">
          <div class="stack">
            <ViText tag="p" variant="body-XS-wide" class="muted">
              Место для гостя выбирает backend по приоритету single → double → triple и гостевому
              резерву.
            </ViText>
            <ViSelect
              :value="guest.hostUserId"
              :options="hostOptions"
              label="Приглашающий"
              label-type="static"
              text-field-name="text"
              value-field-name="value"
              track-by-value
              has-search
              clearable
              @update:value="guest.hostUserId = $event"
            />
            <ViInput v-model:value="guest.guestName" label="Гость" label-type="static" required />
            <ViInput v-model:value="guest.guestPhone" label="Телефон" label-type="static" />
            <ViInput v-model:value="guest.vehiclePlateNumber" label="Авто" label-type="static" />
            <ViButton
              color="primary"
              :loading="busy"
              :disabled="!guest.hostUserId || !guest.guestName"
              @click="createGuest"
            >
              Создать гостя
            </ViButton>
          </div>
        </ViSpoiler>
      </template>
    </ViCardContent>
  </ViCard>
</template>
