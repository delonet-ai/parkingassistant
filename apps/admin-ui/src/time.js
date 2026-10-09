/**
 * A masked ViInput emits the *unmasked* value: `mask="##:##"` shows `15:30` in the field and
 * emits `"1530"`. The API wants `HH:MM`, so the separator is put back here rather than in a
 * component, and the pair is covered by tests — posting `"1530"` would have been refused by
 * the backend with a message about the format, which is a confusing thing to show an operator
 * who typed the time correctly.
 */
export function digitsToTime(value) {
  const digits = String(value || '').replace(/\D/g, '')

  if (digits.length !== 4) {
    return null
  }

  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2))

  if (hours > 23 || minutes > 59) {
    return null
  }

  return `${digits.slice(0, 2)}:${digits.slice(2)}`
}
