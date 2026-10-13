/**
 * Calendar-date formatting that is safe in every timezone.
 *
 * `date.toISOString().slice(0, 10)` converts to UTC first, so a Date built at
 * local midnight (e.g. `new Date(2024, 3, 1)`) is labelled as the previous day
 * anywhere east of UTC — including London during BST.
 */
const pad2 = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' from the Date's local calendar fields. */
export function toLocalISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
