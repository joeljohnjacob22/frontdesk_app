// Test helpers: write times the way Arvo's staff read them (IST), compare as readable strings.
const IST_OFFSET_MS = 330 * 60_000;

// ist('2026-11-20 18:00')  or  ist('2026-11-20 18:29:30')
export function ist(text) {
  const iso = text.replace(' ', 'T') + (text.length === 16 ? ':00' : '') + '+05:30';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Bad test time: ${text}`);
  return date;
}

// fmt(date) -> '2026-11-23 11:00' (IST). Seconds are dropped.
export function fmt(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}
