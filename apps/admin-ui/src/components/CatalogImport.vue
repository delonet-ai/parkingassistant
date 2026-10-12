<script setup>
import { ref } from 'vue'
import { ViAlert, ViButton, ViText } from '@vi-frontend/vision-ui'

import { api } from '../api'
import { loadDay, notify } from '../store'

// The Excel catalog, imported from the browser instead of from a shell on the server.
//
// Two explicit steps, never one: the first upload is a dry run the API rolls back, and only a
// second press writes. The catalog is the parking's inventory — a wrong file applied in one
// click would rewrite every place's title, line and role, and the operator would find out from
// the Места tab afterwards. So the counts the API answers with are what the operator approves,
// and choosing another file throws that approval away.
//
// No rule is evaluated here: which rows are places, which are problems and what an import would
// create or update are all the API's answers. This file renders them and labels the reasons.
const PROBLEM_LABELS = {
  missing_required_cells: 'не заполнены уровень, место или статус',
  place_without_digits: 'в номере места нет цифр',
  duplicate_code: 'номер места повторяется — строка пропущена'
}

const fileInput = ref(null)
const chosen = ref(null)
const preview = ref(null)
const problems = ref([])
const problemsTotal = ref(0)
const busy = ref('')

function problemLabel(problem) {
  return PROBLEM_LABELS[problem.reason] || problem.reason
}

function reset() {
  chosen.value = null
  preview.value = null
  problems.value = []
  problemsTotal.value = 0

  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

function chooseFile(event) {
  chosen.value = event.target.files?.[0] || null
  // A new file invalidates the approved preview: applying it would write a workbook whose
  // counts the operator never saw.
  preview.value = null
  problems.value = []
  problemsTotal.value = 0
}

async function send(dryRun) {
  if (!chosen.value) {
    return
  }

  // The file this request is about, kept apart from `chosen`: the answer approves *this* file,
  // and if the operator picks another one (or cancels) while it is in flight, rendering the
  // answer would put the old file's counts above an "Применить" that uploads the new one.
  const file = chosen.value
  busy.value = dryRun ? 'preview' : 'apply'

  try {
    const form = new FormData()
    form.append('catalogFile', file)
    form.append('dryRun', dryRun ? 'true' : 'false')

    // Through api.js, not `fetch`: a session that expired between choosing the file and
    // applying it has to drop to the login screen, the same as every other refused call.
    const result = await api.postForm('/admin/catalog-import', form)
    const payload = result.data

    if (dryRun && chosen.value !== file) {
      return
    }

    // A refusal may still carry the rows it could not read — that is the answer to "why
    // nothing was understood", so it is rendered rather than swallowed with the toast.
    problems.value = (payload && payload.problems) || []
    // The API reports the first few hundred refused rows and counts the rest: a wrong file can
    // refuse more rows than this block could ever render, and the operator needs the number.
    problemsTotal.value = (payload && payload.problemsTotal) || problems.value.length

    // `import` missing from an ok answer is not an import of nothing: it is an answer this
    // screen cannot read, and saying so beats rendering counts from `undefined`.
    if (!result.ok || !payload.import) {
      preview.value = null
      notify('error', result.error || 'Сервер не сообщил, что именно изменится.')
      return
    }

    if (dryRun) {
      preview.value = payload.import
      notify('success', 'Файл прочитан. Проверьте, что именно изменится, и примените.')
      return
    }

    const applied = payload.import
    reset()
    notify(
      'success',
      `Каталог импортирован: мест создано ${applied.placesCreated}, обновлено ${applied.placesUpdated}.`
    )
    await loadDay()
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="stack">
    <ViText tag="p" variant="body-M-wide" class="muted">
      Выгрузка из Excel: лист «Лист1», шапка во второй строке. Сначала проверка — она ничего не
      записывает, — потом применение.
    </ViText>

    <div class="form-row">
      <input
        ref="fileInput"
        type="file"
        accept=".xlsx"
        hidden
        @change="chooseFile"
      />
      <ViButton
        size="small"
        variant="outlined"
        color="secondary"
        :disabled="Boolean(busy)"
        @click="fileInput?.click()"
      >
        Выбрать файл
      </ViButton>
      <ViButton
        size="small"
        variant="outlined"
        color="secondary"
        :disabled="!chosen || Boolean(busy)"
        :loading="busy === 'preview'"
        @click="send(true)"
      >
        Проверить файл
      </ViButton>
      <ViText v-if="chosen" tag="span" variant="body-Sm-wide">{{ chosen.name }}</ViText>
    </div>

    <template v-if="preview">
      <ViAlert type="info" title="Что изменится">
        Мест в файле: {{ preview.placesStaged }} · создать {{ preview.placesCreated }} ·
        обновить {{ preview.placesUpdated }} · линий создать {{ preview.linesCreated }} ·
        обновить {{ preview.linesUpdated }}. Строк прочитано: {{ preview.rowsRead }}.
      </ViAlert>

      <div class="form-row">
        <ViButton size="small" :loading="busy === 'apply'" @click="send(false)">
          Применить к каталогу
        </ViButton>
        <ViButton size="small" variant="outlined" color="secondary" :disabled="Boolean(busy)" @click="reset">
          Отменить
        </ViButton>
      </div>
    </template>

    <ViAlert v-if="problems.length" type="warning" title="Строки, которые не станут местами">
      <div class="stack-tight">
        <ViText v-for="problem in problems" :key="`${problem.row}-${problem.reason}`" tag="span" variant="body-XS-wide">
          строка {{ problem.row }}: {{ problem.place || '—' }} — {{ problemLabel(problem) }}
        </ViText>
        <ViText v-if="problemsTotal > problems.length" tag="span" variant="body-XS-wide" class="muted">
          …и ещё {{ problemsTotal - problems.length }} таких строк — показаны первые
          {{ problems.length }}.
        </ViText>
      </div>
    </ViAlert>
  </div>
</template>
