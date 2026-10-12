// A plan file name as this app serves it: `/maps/<name>` reads one file out of the map volume,
// so the name is a single segment with no separators, no `%` escapes and no leading dot.
const PLAN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Where to find a floor's plan image.
 *
 * The plan file is named by the API's row, not by this app: admin-ui's server writes a fresh
 * file name per upload so the row never names bytes that do not exist, which also means the
 * old guess — `/maps/parking-g3.png` — showed the previous plan, or nothing, after every
 * upload that was not a png. `null` when the floor has no plan yet.
 *
 * The row is not trusted beyond the file name. `POST /admin/map-backgrounds` stores any
 * non-empty `filePath`, so a row could name `//attacker.example/pixel`, `https://…` or an
 * unrelated absolute path — and every operator's browser would then fetch it while rendering
 * Day or Места. Only this app's own `/maps/<name>` is ever requested; anything else is no plan.
 */
export function planImageSrc(map) {
  const stored = String(map?.metadata?.filePath || '').trim()

  if (!stored) {
    return null
  }

  // Seeded rows hold a bare file name; an upload stores the path the browser asks for.
  const name = stored.startsWith('/maps/') ? stored.slice('/maps/'.length) : stored

  return PLAN_FILE_NAME.test(name) ? `/maps/${name}` : null
}
