// Шрифты Vision UI и иконочный шрифт подключены в CSS абсолютными путями
// (/fonts/..., /vi-icons-font/...). Vite их не разрешает на сборке, поэтому
// кладём их в public/, откуда они раздаются по этим же путям.
import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pairs = [
  ['node_modules/@vi-frontend/vision-ui/dist/fonts', 'public/fonts'],
  ['node_modules/@vi-frontend/svgs/dist/vi-icons-font', 'public/vi-icons-font'],
]

await mkdir(resolve(root, 'public'), { recursive: true })
for (const [from, to] of pairs) {
  const src = resolve(root, from)
  if (!existsSync(src)) {
    console.error(`copy-vi-assets: не найдено ${from} — шрифты не скопированы`)
    process.exitCode = 1
    continue
  }
  await cp(src, resolve(root, to), { recursive: true })
  console.log(`copy-vi-assets: ${from} -> ${to}`)
}
