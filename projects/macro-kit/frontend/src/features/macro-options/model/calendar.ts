// Calendar for ICE Euribor futures and options (London wall-clock, stored as UTC Dates).
// Futures month codes, Jan → Dec
export const MONTH_CODES = 'FGHJKMNQUVXZ'
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const SESSION_OPEN_H  = 1    // ICE Euribor futures & options, London time
export const SESSION_CLOSE_H = 21
export const EXPIRY_HOUR     = 10   // options cease trading 10:00 London on LTD


export function londonNow(): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]),
  )
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute))
}

// ─── Holiday calendars ────────────────────────────────────────────────────────
// A business day must be open in London (ICE Futures Europe) AND a TARGET day
// (Euribor fixing published). Special one-off UK holidays are not modelled.

// Easter Sunday (anonymous Gregorian algorithm), as [month 1–12, day]
export function easterSunday(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  return [month, ((h + l - 7 * m + 114) % 31) + 1]
}

export const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

export function nthWeekday(y: number, m: number, dow: number, n: number): number {     // n-th (1-based) or last (n = -1)
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
    return 1 + ((dow - first + 7) % 7) + 7 * (n - 1)
  }
  const lastDay = new Date(Date.UTC(y, m, 0))
  return lastDay.getUTCDate() - ((lastDay.getUTCDay() - dow + 7) % 7)
}

const _holidayCache = new Map<number, Set<string>>()

export function holidays(y: number): Set<string> {
  const hit = _holidayCache.get(y)
  if (hit) return hit
  const out = new Set<string>()
  const [em, ed] = easterSunday(y)
  const easter = Date.UTC(y, em - 1, ed)
  const offset = (days: number) => new Date(easter + days * 864e5)
  const add = (dt: Date) => out.add(dt.toISOString().slice(0, 10))

  // TARGET: New Year, Good Friday, Easter Monday, 1 May, 25 & 26 Dec
  out.add(ymd(y, 1, 1)); add(offset(-2)); add(offset(1)); out.add(ymd(y, 5, 1)); out.add(ymd(y, 12, 25)); out.add(ymd(y, 12, 26))

  // England & Wales bank holidays (weekend dates roll to the next free weekday)
  const dowOf = (m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const ny = dowOf(1, 1)
  out.add(ymd(y, 1, ny === 6 ? 3 : ny === 0 ? 2 : 1))
  out.add(ymd(y, 5, nthWeekday(y, 5, 1, 1)))        // early May
  out.add(ymd(y, 5, nthWeekday(y, 5, 1, -1)))       // spring
  out.add(ymd(y, 8, nthWeekday(y, 8, 1, -1)))       // summer
  const xmas = dowOf(12, 25)
  if (xmas === 6) { out.add(ymd(y, 12, 27)); out.add(ymd(y, 12, 28)) }        // Sat → Mon/Tue
  else if (xmas === 0) { out.add(ymd(y, 12, 27)) }                             // Sun → Tue (Boxing on Mon)
  else if (xmas === 5) { out.add(ymd(y, 12, 28)) }                             // Boxing Sat → Mon

  _holidayCache.set(y, out)
  return out
}

export function isBusinessDay(d: Date): boolean {
  const dow = d.getUTCDay()
  return dow !== 0 && dow !== 6 && !holidays(d.getUTCFullYear()).has(d.toISOString().slice(0, 10))
}

// Last trading day: two business days before the third Wednesday of the month
// (normally the Monday; earlier when a holiday intervenes, e.g. Easter Monday)
export function lastTradingDay(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month - 1, nthWeekday(year, month, 3, 3), EXPIRY_HOUR, 0))
  let back = 0
  while (back < 2) {
    d.setUTCDate(d.getUTCDate() - 1)
    if (isBusinessDay(d)) back++
  }
  return d
}

// Snap to the last moment the market was open (weekends, holidays, outside session hours)
export function snapToSession(d: Date): Date {
  const s = new Date(d)
  for (let i = 0; i < 12; i++) {
    const hr = s.getUTCHours() + s.getUTCMinutes() / 60
    if (!isBusinessDay(s) || hr < SESSION_OPEN_H) {
      s.setUTCDate(s.getUTCDate() - 1)
      s.setUTCHours(SESSION_CLOSE_H, 0, 0, 0)
    } else if (hr > SESSION_CLOSE_H) {
      s.setUTCHours(SESSION_CLOSE_H, 0, 0, 0)
    } else break
  }
  return s
}

export const fmtSnap = (d: Date) =>
  `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })} ` +
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} London`

export const toDateInput = (d: Date) => d.toISOString().slice(0, 10)
export const toTimeInput = (d: Date) => d.toISOString().slice(11, 16)

// Serial (non-quarterly) option months expire on the Friday before the third Wednesday,
// a business day earlier for each holiday in the way (Bloomberg OPT_EXPIRE_DT, 2026-10-18)
export function serialExpiry(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month - 1, nthWeekday(year, month, 3, 3) - 5, EXPIRY_HOUR, 0))
  while (!isBusinessDay(d)) d.setUTCDate(d.getUTCDate() - 1)
  return d
}

export const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })

/** "2026-11-13T10:00" (London wall clock, as the backend sends it) → Date stored as UTC */
export const parseLondon = (s: string) => new Date(`${s.length === 10 ? `${s}T00:00` : s.slice(0, 16)}:00Z`)
