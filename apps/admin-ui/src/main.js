import { createApp } from 'vue'

// Order matters: design-system tokens and styles first, then the fonts, then our own ground.
//
// Both stylesheets are needed. Components from `/next` (ViCard, ViCardContent) ship their
// styles in a separate bundle, so importing only the first one renders their markup with
// hashed class names that nothing defines — cards with no background, no border and no
// padding, which is exactly how the first build looked.
import '@vi-frontend/vision-ui/css'
import '@vi-frontend/vision-ui/css/next'
import '@vi-frontend/vision-ui/fonts/vi-sans-fonts.css'
import '@vi-frontend/svgs/dist/vi-icons-font/vi-icons-font.css'
import './base.css'

import App from './App.vue'

createApp(App).mount('#app')
