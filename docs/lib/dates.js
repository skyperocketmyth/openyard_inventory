/**
 * Dubai time, and the day boundaries the Activity filter works in.
 *
 * WHY THIS IS ITS OWN MODULE. It used to be a `when()` helper buried in
 * index.html, which meant the one piece of logic in this app that is genuinely
 * easy to get wrong — and impossible to eyeball — had no test around it. A
 * timezone bug does not throw. It shows 05:05 for a truck that arrived at
 * 09:05, which is a completely plausible time, and nobody notices until a day's
 * movements are reconciled against the paperwork and come up short.
 *
 * EVERYTHING HERE IS PINNED TO Asia/Dubai, never to the device.
 * The phone is in the yard, so its local time is usually Dubai time already —
 * but "usually" is doing a lot of work in a sentence about stock records. A
 * handset with the wrong timezone, a tablet someone brought back from leave, or
 * a browser reporting UTC would all silently relabel which DAY a movement
 * belongs to. Pinning the zone means the app agrees with the Sheet, which is
 * formatted Asia/Dubai server-side, no matter what the device believes.
 *
 * The offset is MEASURED, not hardcoded to +4. Dubai has never observed DST and
 * almost certainly never will, so `+4` would be correct today and for the
 * foreseeable life of this app — but measuring it costs one Intl call and
 * removes an assumption that nothing would ever check again.
 */

const ZONE = 'Asia/Dubai';
const DAY_MS = 86400000;

/**
 * Formatter instances are expensive to construct and these are hit once per
 * ledger row on every repaint, so both are built once.
 */
const PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  // h23, not hour12:false. `hour12:false` is allowed to render midnight as
  // "24" in some engines, which would print 24-09-2026 24:00:00 for a
  // movement recorded a second after midnight.
  hourCycle: 'h23'
});

function partsOf(ms) {
  const out = {};
  for (const p of PARTS_FMT.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/**
 * How far ahead of UTC Dubai is, at a given instant, in milliseconds.
 *
 * Measured by rendering the instant as Dubai wall-clock parts, reading those
 * parts back as if they were UTC, and taking the difference.
 */
function offsetMsAt(ms) {
  const p = partsOf(ms);
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)
  );
  // Against the instant TRUNCATED TO THE SECOND, because `asUTC` was rebuilt
  // from parts that only go down to seconds. Differencing against the raw
  // millisecond value folds the leftover milliseconds into the offset, and
  // `dayStartMs` then returns a "midnight" a few hundred milliseconds late —
  // which is harmless for filtering but makes the boundary wrong, the ISO
  // string it produces untidy, and any exact-boundary test unpassable.
  return asUTC - (ms - (ms % 1000 + 1000) % 1000);
}

/**
 * The instant at which a Dubai calendar day began, `daysBack` days ago.
 *
 * @param {number} daysBack  0 = today, 1 = yesterday.
 * @param {number} [nowMs]   for tests; defaults to the real clock.
 * @return {number} epoch milliseconds
 *
 * Subtracting whole days from midnight is exact in a zone with no DST. In a
 * zone that had it, one of these boundaries could land an hour out twice a
 * year — so if this is ever reused outside Dubai, recompute the offset per day
 * instead of reusing today's.
 */
export function dayStartMs(daysBack, nowMs) {
  const at = nowMs === undefined ? Date.now() : nowMs;
  const p = partsOf(at);
  const midnight = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))
    - offsetMsAt(at);
  return midnight - (Number(daysBack) || 0) * DAY_MS;
}

/**
 * A timestamp as the yard reads it: DD-MM-YYYY HH:MM:SS, Dubai time.
 *
 * Accepts an ISO string, a Date, or epoch milliseconds — the server sends ISO
 * strings, but a queued outbox entry carries whatever the device put there.
 * Anything unparseable returns '' rather than "Invalid Date", so a bad cell
 * leaves a gap on screen instead of shouting at a yard worker.
 */
export function fmtDubai(value) {
  if (value === null || value === undefined || value === '') return '';
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(String(value));
  if (isNaN(ms)) return '';
  const p = partsOf(ms);
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** Just the clock part, for places that already say which day they mean. */
export function fmtDubaiTime(value) {
  const full = fmtDubai(value);
  return full ? full.slice(11) : '';
}

/**
 * The ranges the Activity tab offers, in the order they appear on screen.
 *
 * `days` is only documentation here — `windowFor` below owns the arithmetic,
 * because "yesterday" is the one option that is a CLOSED window rather than
 * "everything since", and encoding that as a day count would lose it.
 */
export const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'all', label: 'All time' }
];

export const DEFAULT_RANGE = 'today';

/**
 * A range key as the pair of instants `getLedger` wants.
 *
 * @return {{since: string, until: string, label: string}} ISO instants, or ''
 *   for an open end.
 *
 * "Yesterday" is deliberately the single calendar day, not "since yesterday":
 * it is the only reading of the word that a supervisor asking "what did we do
 * yesterday?" would accept, and the cumulative version is already covered by
 * Last 7 days. It is the reason `until` exists at all.
 *
 * An unknown key falls back to ALL rather than to today — a filter that
 * silently hides movements because of a typo in a chip name is worse than one
 * that shows too many.
 */
export function windowFor(key, nowMs) {
  const iso = ms => new Date(ms).toISOString();
  switch (key) {
    case 'today':
      return { since: iso(dayStartMs(0, nowMs)), until: '', label: 'Today' };
    case 'yesterday':
      return {
        since: iso(dayStartMs(1, nowMs)),
        until: iso(dayStartMs(0, nowMs)),
        label: 'Yesterday'
      };
    case 'week':
      // Today plus the six days before it — seven calendar days, matching the
      // chip that says "Last 7 days".
      return { since: iso(dayStartMs(6, nowMs)), until: '', label: 'Last 7 days' };
    case 'month':
      return { since: iso(dayStartMs(29, nowMs)), until: '', label: 'Last 30 days' };
    default:
      return { since: '', until: '', label: 'All time' };
  }
}
