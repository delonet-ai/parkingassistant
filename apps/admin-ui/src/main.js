import { createApp } from 'vue'

// Order matters: design-system tokens and styles first, then the fonts, then our own ground.
import '@vi-frontend/vision-ui/css'
import '@vi-frontend/vision-ui/fonts/vi-sans-fonts.css'
import '@vi-frontend/svgs/dist/vi-icons-font/vi-icons-font.css'
import './base.css'

import App from './App.vue'

createApp(App).mount('#app')
