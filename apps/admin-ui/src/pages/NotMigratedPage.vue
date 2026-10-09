<script setup>
import { ViAlert, ViText } from '@vi-frontend/vision-ui'

import { TABS, state } from '../store'

const title = () => (TABS.find((tab) => tab.value === state.view) || {}).title || state.view
</script>

<template>
  <ViAlert type="info" :title="`Вкладка «${title()}» ещё не перенесена`">
    <ViText tag="p" variant="body-M-wide">
      Перенос интерфейса на дизайн-систему идёт вкладка за вкладкой, и эта пока работает в прежней
      админке. Открывается она там же, на порту <strong>3340</strong>, тем же адресом
      <code>/?view={{ state.view }}</code>. Данные и операции общие — backend один.
    </ViText>
  </ViAlert>
</template>
