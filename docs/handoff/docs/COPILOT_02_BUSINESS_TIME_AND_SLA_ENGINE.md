# COPILOT 02: Business-Time and SLA Engine

**Project:** Frontdesk (Arvo Systems hiring test). **Previous step:** `COPILOT_01_SETUP_AND_MIGRATIONS.md` (done, `npm test` green).

| # | Document | Delivers |
|---|---|---|
| 01 | Setup and migrations | Repo, DB, seed, skeleton, test harness (**done**) |
| **02** | **Business-time and SLA engine (this file)** | Working-hours calendar, due-date maths, pause/priority/auto-close/reopen rules, 100% unit-tested |
| 03 | Auth and ticket lifecycle API | Claim, reply, note, statuses, audit events, privacy tests |
| 04 | Background job | Breach detection, auto-close, resolved→closed |
| 05 | Agent UI and customer view | React screens, exports |
| 06 | Deploy and README | Hosting, README, "what I did not finish" note |

---

## 0. Why this step comes first, and why it is "pure"

Every ticket endpoint needs to answer "when is this due?" and "how long was it paused?". Those answers depend on working hours, weekends and holidays. If that logic is wrong, every later step is wrong in a way that is hard to see.

So this step builds the logic as **pure functions with no database and no Express**. A pure function takes values in and returns values out, so it can be tested with a table of examples. The only database code in this step is one small loader (`engineConfig.js`) that reads the settings, holidays and policies tables created in Step 01 and hands plain objects to the pure code.

**How to use this document:** same as Step 01. Paste the prompt from Step 01 §0, replacing the file name and step number. Work in the order of §5. **The tests in this document are LOCKED**: Copilot writes the implementation to satisfy them and must never edit a test to make it pass.

---

## 1. What the brief says, and what it means in code

| Brief (Meera, §3) | Rule in code | Where tested |
|---|---|---|
| "Working hours, not normal clock hours. 9:30 to 6:30, Monday to Friday." | Day = `[09:30, 18:30)` IST. 540 business minutes per working day. | `calendar.test.js` |
| "We do not work on festival holidays." | Holiday dates (from the `holidays` table) are non-working days. | `calendar.test.js`, `engineConfig.test.js` |
| "Arrives 6 PM Friday: should not be late on Sunday morning." | The clock starts at the next opening. Due dates only land inside working time. | `sla.test.js` ("Friday 6 PM") |
| High: reply 2 h, fix the same working day | reply = 120 business minutes. Resolve = until the close of the day the clock started. | `sla.test.js` |
| Medium: reply half a day, fix about 3 days | reply = 270, resolve = 1620 (3 × 540) | `sla.test.js` |
| Low: reply 1 day, fix about a week | reply = 540, resolve = 2700 (5 × 540) | `sla.test.js` |
| "Waiting for the customer still counts against us. That week is not our fault." | Paused business minutes are **added** to the resolve budget. | `sla.test.js` ("pause") |
| "No reply for about one working week: close it." | `autoCloseAt = waitingSince + 2700 business minutes` | `sla.test.js` |
| "Reopen for only about one week." | `reopenUntil = resolvedAt + 2700 business minutes` | `sla.test.js` |
| "What happens to the timer if we change a ticket to urgent in the middle? Nobody knew." | Our decision, see §3 row 6. | `sla.test.js` ("priority change") |

---

## 2. Semantics (the precise rules)

All instants are JavaScript `Date` objects (UTC internally). "Local" means **Asia/Kolkata (UTC+05:30, no daylight saving)**. Working hours are Monday to Friday, 09:30 to 18:30, excluding holidays.

| Rule | Detail |
|---|---|
| **Half-open day** | A working day is open from 09:30:00.000 **up to but not including** 18:30:00.000. At exactly 09:30 it is open. At exactly 18:30 it is closed. |
| **nextOpening(t)** | If `t` is inside working time, return `t`. Otherwise return the next 09:30 on a working day. |
| **addBusinessMinutes(start, n)** | Move `start` to `nextOpening(start)`, then count `n` business minutes forward. If the count ends **exactly** at 18:30, the result is that 18:30 (not the next morning). `n = 0` returns `nextOpening(start)`. `n < 0` throws `RangeError`. |
| **businessMinutesBetween(a, b)** | Whole business minutes in `[a, b)`. `0` if `b <= a`. Floors partial minutes. |
| **closingTime(t)** | 18:30 local of the local day containing `t`. |
| **Inverse property** | For `n > 0`: `businessMinutesBetween(nextOpening(s), addBusinessMinutes(s, n)) === n`. |
| **Cycle clock start** | `clockStartAt = floorToMinute(nextOpening(arrival))`. `startedAt` keeps the real arrival time. |
| **Reply budget** | `policy.replyMinutes` (120 / 270 / 540). |
| **Resolve budget** | `policy.resolveMinutes`, **or** if `resolveSameDay` (High): `max(1, businessMinutesBetween(clockStartAt, closingTime(clockStartAt)))`. |
| **Reply due** | `addBusinessMinutes(clockStartAt, replyBudget)`. **Pauses never move it** (a ticket can only wait after a first reply). |
| **Resolve due** | `addBusinessMinutes(clockStartAt, resolveBudget + pausedBusinessMinutes)` |
| **Paused minutes** | `businessMinutesBetween(pausedAt, resumedAt)`, stored as an integer on the pause row. |
| **Priority change** | Keep the **same `clockStartAt`**. Recompute budgets for the new priority from that start. Elapsed time is kept, so escalating can make a ticket instantly late. |
| **autoCloseAt / reopenUntil** | `addBusinessMinutes(from, 2700)` (5 working days). |
| **Overdue** | `now > dueAt` (strictly later). Exactly at the due instant is **not** late. |

Worked examples (these appear as tests):

| Situation | Result |
|---|---|
| Fri 18:00 + 120 min | **Mon 11:00** (30 min Friday, 90 min Monday) |
| Fri 17:00 + 270 min (Medium reply) | Mon 12:30 |
| Fri 17:00 + 1620 min (Medium resolve) | Wed 17:00 |
| Mon 09:30 + 540 min | **Mon 18:30** (same day, not Tuesday) |
| Thu 24 Dec 17:30 + 120 min (Fri 25 Dec is a holiday) | Mon 28 Dec 10:30 |
| Paused Fri 17:20 → Wed 10:00 | 70 + 540 + 540 + 30 = **1180** business minutes |

---

## 3. Decisions to append to `docs/DECISIONS.md`

Copilot adds these rows (one per line) when this step is committed. They become the decision log in the README.

| # | Decision | Reason |
|---|---|---|
| 1 | Time zone is fixed-offset Asia/Kolkata (+05:30). Zones are listed in `ZONE_OFFSETS`. Zones with daylight saving are intentionally unsupported. | Kolkata has no DST, so integer arithmetic is exact and needs no date library. |
| 2 | Working day is the half-open interval [09:30, 18:30). There is no lunch break. | The brief gives only "9:30 to 6:30". |
| 3 | A due date that lands exactly on 18:30 stays on that day. | A deadline at close of business is not met or missed until after 18:30. |
| 4 | "Half a day" = 270 min. "One day" = 540. "About three days" = 1620. "About a week" = 5 working days = 2700. | Meera used approximate words. Values live in the `sla_policies` and `settings` tables so they are adjustable. |
| 5 | "Fix the same working day" (High) is due at the close of the day the clock started. | Literal reading. |
| 6 | **Priority change keeps the original clock start.** New budgets apply to total elapsed time. Escalation can make a ticket instantly late. Downgrading never erases a recorded breach. | Meera's unanswered question. Resetting the clock would let an agent hide lateness by changing priority. |
| 7 | Pauses extend only the resolve deadline, never the reply deadline. | A ticket can only wait on the customer after an agent replied. |
| 8 | Clock start is floored to the whole minute. | Budgets are whole minutes. A ticket arriving at 18:29:30 gets a 1-minute same-day budget instead of an impossible 0. |
| 9 | Auto-close and reopen windows are 2700 business minutes counted from the moment waiting began or the ticket was resolved. | "About one working week". |

---

## 4. Files and public API

```
server/lib/
  calendar.js        createCalendar(), floorToMinute(), toMs(), ZONE_OFFSETS      (pure)
  sla.js             budgetsFor, dueDates, startCycle, recomputeForPriority,
                     autoCloseAt, reopenUntil, pausedMinutes, isOverdue           (pure)
  engineConfig.js    loadEngineConfig(db)                                         (reads DB)
tests/
  helpers/time.js    ist(), fmt()
  calendar.test.js   sla.test.js   engineConfig.test.js
```

**`createCalendar({ timezone, workStart, workEnd, workDays, holidays })`** returns:

| Method | Returns |
|---|---|
| `isWorkingDay(t)` | boolean (local day is a working weekday and not a holiday) |
| `nextOpening(t)` | `Date` |
| `addBusinessMinutes(start, minutes)` | `Date` |
| `businessMinutesBetween(a, b)` | integer |
| `closingTime(t)` | `Date` (18:30 local of `t`'s local day) |
| `localDate(t)` | `'YYYY-MM-DD'` in local time |

`t` may be a `Date`, epoch milliseconds, or an ISO string. Functions never mutate their inputs and always return new `Date` objects.

**The `engine` object** passed to the `sla.js` functions: `{ calendar, policies, autoCloseMinutes, reopenMinutes }`, where `policies` is `{ high: { replyMinutes, resolveMinutes, resolveSameDay }, medium: {...}, low: {...} }`. `loadEngineConfig(db)` builds it from the database.

**`sla.js` functions**

| Function | Returns |
|---|---|
| `startCycle(engine, priority, arrivalAt)` | `{ priority, startedAt, clockStartAt, replyBudgetMinutes, resolveBudgetMinutes, replyDueAt, resolveDueAt }` (these map onto `sla_cycles` columns) |
| `dueDates(engine, { clockStartAt, replyBudgetMinutes, resolveBudgetMinutes, pausedBusinessMinutes })` | `{ replyDueAt, resolveDueAt }` (use after a pause resumes) |
| `recomputeForPriority(engine, cycle, newPriority, pausedBusinessMinutes)` | `{ priority, replyBudgetMinutes, resolveBudgetMinutes, replyDueAt, resolveDueAt }` |
| `budgetsFor(engine, priority, clockStartAt)` | `{ replyBudgetMinutes, resolveBudgetMinutes }` |
| `pausedMinutes(engine, pausedAt, resumedAt)` | integer |
| `autoCloseAt(engine, waitingSince)` / `reopenUntil(engine, resolvedAt)` | `Date` |
| `isOverdue(dueAt, now)` | boolean |

---

## 5. Steps

### Step 1: Test helpers and the tests (write the tests FIRST, expect red)

```js file=tests/helpers/time.js
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
```

Calendar for the tests: **Fri 20 Nov 2026** is a working day, **Sat 21 / Sun 22 Nov** is a weekend, **Mon 23 Nov** is a working day, and **Fri 25 Dec 2026** is a holiday.

```js file=tests/calendar.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar } from '../server/lib/calendar.js';
import { ist, fmt } from './helpers/time.js';

const cal = createCalendar({ holidays: ['2026-12-25'] });

test('isWorkingDay: weekdays yes, weekends no, holidays no', () => {
  assert.equal(cal.isWorkingDay(ist('2026-11-20 12:00')), true);   // Fri
  assert.equal(cal.isWorkingDay(ist('2026-11-21 12:00')), false);  // Sat
  assert.equal(cal.isWorkingDay(ist('2026-11-22 12:00')), false);  // Sun
  assert.equal(cal.isWorkingDay(ist('2026-11-23 12:00')), true);   // Mon
  assert.equal(cal.isWorkingDay(ist('2026-12-25 12:00')), false);  // Christmas (Fri)
});

test('isWorkingDay uses the IST day, not the UTC day', () => {
  // 00:30 IST Monday is still Sunday 19:00 in UTC.
  assert.equal(cal.isWorkingDay(ist('2026-11-23 00:30')), true);
  assert.equal(cal.localDate(ist('2026-11-23 00:30')), '2026-11-23');
});

test('nextOpening', () => {
  const cases = [
    ['2026-11-20 18:00', '2026-11-20 18:00'],   // inside hours: unchanged
    ['2026-11-23 09:30', '2026-11-23 09:30'],   // exactly at opening: open
    ['2026-11-23 08:00', '2026-11-23 09:30'],   // before opening
    ['2026-11-20 18:30', '2026-11-23 09:30'],   // exactly at close: closed -> Monday
    ['2026-11-20 18:30:01', '2026-11-23 09:30'],
    ['2026-11-21 12:00', '2026-11-23 09:30'],   // Saturday
    ['2026-11-22 23:59', '2026-11-23 09:30'],   // Sunday night
    ['2026-12-24 18:40', '2026-12-28 09:30'],   // Thu night -> skips holiday Fri + weekend
  ];
  for (const [input, expected] of cases) {
    assert.equal(fmt(cal.nextOpening(ist(input))), expected, `nextOpening(${input})`);
  }
});

test('addBusinessMinutes', () => {
  const cases = [
    ['2026-11-20 18:00', 120, '2026-11-23 11:00'],   // Friday 6 PM + 2 h = Monday 11:00
    ['2026-11-23 09:30', 540, '2026-11-23 18:30'],   // a full day ends at 18:30 the same day
    ['2026-11-23 09:30', 541, '2026-11-24 09:31'],
    ['2026-11-20 17:00', 270, '2026-11-23 12:30'],   // Medium reply
    ['2026-11-20 17:00', 1620, '2026-11-25 17:00'],  // Medium resolve
    ['2026-11-21 12:00', 120, '2026-11-23 11:30'],   // starts on Saturday
    ['2026-11-21 12:00', 0, '2026-11-23 09:30'],     // zero minutes -> next opening
    ['2026-11-23 09:30', 2700, '2026-11-27 18:30'],  // five full days
    ['2026-12-24 17:30', 120, '2026-12-28 10:30'],   // skips the Dec 25 holiday and the weekend
  ];
  for (const [start, minutes, expected] of cases) {
    assert.equal(fmt(cal.addBusinessMinutes(ist(start), minutes)), expected, `${start} + ${minutes}`);
  }
});

test('addBusinessMinutes rejects negative or non-numeric minutes and never mutates input', () => {
  assert.throws(() => cal.addBusinessMinutes(ist('2026-11-20 10:00'), -1), RangeError);
  assert.throws(() => cal.addBusinessMinutes(ist('2026-11-20 10:00'), NaN), RangeError);
  const start = ist('2026-11-20 10:00');
  const before = start.getTime();
  cal.addBusinessMinutes(start, 5000);
  assert.equal(start.getTime(), before);
});

test('businessMinutesBetween', () => {
  const cases = [
    ['2026-11-20 18:00', '2026-11-23 10:00', 60],     // 30 Fri + 30 Mon
    ['2026-11-21 10:00', '2026-11-22 10:00', 0],      // weekend
    ['2026-11-23 09:30', '2026-11-23 18:30', 540],    // one full day
    ['2026-11-23 00:00', '2026-11-25 00:00', 1080],   // Mon + Tue
    ['2026-12-24 09:30', '2026-12-28 18:30', 1080],   // Thu + Mon (Fri holiday, weekend)
    ['2026-11-23 12:00', '2026-11-23 12:00', 0],      // empty
    ['2026-11-23 12:00', '2026-11-23 11:00', 0],      // reversed
    ['2026-11-20 17:20', '2026-11-25 10:00', 1180],   // the pause example: 70+540+540+30
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(cal.businessMinutesBetween(ist(a), ist(b)), expected, `${a} -> ${b}`);
  }
});

test('closingTime is 18:30 of the same local day', () => {
  assert.equal(fmt(cal.closingTime(ist('2026-11-23 12:00'))), '2026-11-23 18:30');
  assert.equal(fmt(cal.closingTime(ist('2026-11-23 09:30'))), '2026-11-23 18:30');
});

test('property: add and between are inverses (500 pseudo-random cases)', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const base = ist('2026-11-01 00:00').getTime();
  for (let i = 0; i < 500; i++) {
    const start = new Date(base + Math.floor(rnd() * 92 * 86_400_000));   // Nov 1 .. Jan 31
    const n = 1 + Math.floor(rnd() * 4000);
    const end = cal.addBusinessMinutes(start, n);
    assert.equal(cal.businessMinutesBetween(cal.nextOpening(start), end), n, `start=${start.toISOString()} n=${n}`);
    // The result is always inside working time or exactly at a closing time.
    assert.equal(cal.isWorkingDay(new Date(end.getTime() - 1)), true);
    assert.ok(cal.addBusinessMinutes(start, n + 1) > end, 'strictly increasing');
  }
});

test('invalid calendars are rejected', () => {
  assert.throws(() => createCalendar({ timezone: 'Europe/London' }), /Unsupported timezone/);
  assert.throws(() => createCalendar({ workStart: '18:30', workEnd: '09:30' }));
  assert.throws(() => createCalendar({ workDays: [] }));
});
```

```js file=tests/sla.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar } from '../server/lib/calendar.js';
import {
  startCycle, recomputeForPriority, dueDates, pausedMinutes,
  autoCloseAt, reopenUntil, isOverdue,
} from '../server/lib/sla.js';
import { ist, fmt } from './helpers/time.js';

const engine = {
  calendar: createCalendar({ holidays: ['2026-12-25'] }),
  policies: {
    high:   { replyMinutes: 120, resolveMinutes: null, resolveSameDay: true },
    medium: { replyMinutes: 270, resolveMinutes: 1620, resolveSameDay: false },
    low:    { replyMinutes: 540, resolveMinutes: 2700, resolveSameDay: false },
  },
  autoCloseMinutes: 2700,
  reopenMinutes: 2700,
};

test('Friday 6 PM High ticket: due Monday, NOT late on Sunday morning', () => {
  const c = startCycle(engine, 'high', ist('2026-11-20 18:00'));
  assert.equal(fmt(c.clockStartAt), '2026-11-20 18:00');
  assert.equal(c.replyBudgetMinutes, 120);
  assert.equal(fmt(c.replyDueAt), '2026-11-23 11:00');          // 30 Fri + 90 Mon
  assert.equal(c.resolveBudgetMinutes, 30);                     // 18:00 -> 18:30 same day
  assert.equal(fmt(c.resolveDueAt), '2026-11-20 18:30');
  // The spreadsheet said "late" here. We must not.
  assert.equal(isOverdue(c.replyDueAt, ist('2026-11-22 10:00')), false);
  assert.equal(isOverdue(c.replyDueAt, ist('2026-11-23 11:00')), false);    // exactly due: not late
  assert.equal(isOverdue(c.replyDueAt, ist('2026-11-23 11:00:01')), true);
});

test('High ticket arriving on a Saturday starts Monday 09:30', () => {
  const c = startCycle(engine, 'high', ist('2026-11-21 11:00'));
  assert.equal(fmt(c.startedAt), '2026-11-21 11:00');           // real arrival is kept
  assert.equal(fmt(c.clockStartAt), '2026-11-23 09:30');
  assert.equal(fmt(c.replyDueAt), '2026-11-23 11:30');
  assert.equal(c.resolveBudgetMinutes, 540);
  assert.equal(fmt(c.resolveDueAt), '2026-11-23 18:30');
});

test('High ticket arriving exactly at 18:30 starts the next working morning', () => {
  const c = startCycle(engine, 'high', ist('2026-11-23 18:30'));
  assert.equal(fmt(c.clockStartAt), '2026-11-24 09:30');
  assert.equal(fmt(c.resolveDueAt), '2026-11-24 18:30');
});

test('High ticket arriving 30 seconds before close gets a 1-minute budget, not 0', () => {
  const c = startCycle(engine, 'high', ist('2026-11-23 18:29:30'));
  assert.equal(fmt(c.clockStartAt), '2026-11-23 18:29');
  assert.equal(c.resolveBudgetMinutes, 1);
  assert.equal(fmt(c.resolveDueAt), '2026-11-23 18:30');
});

test('Medium ticket Friday 17:00', () => {
  const c = startCycle(engine, 'medium', ist('2026-11-20 17:00'));
  assert.equal(c.replyBudgetMinutes, 270);
  assert.equal(c.resolveBudgetMinutes, 1620);
  assert.equal(fmt(c.replyDueAt), '2026-11-23 12:30');
  assert.equal(fmt(c.resolveDueAt), '2026-11-25 17:00');
});

test('Low ticket Monday 10:00', () => {
  const c = startCycle(engine, 'low', ist('2026-11-23 10:00'));
  assert.equal(fmt(c.replyDueAt), '2026-11-24 10:00');
  assert.equal(fmt(c.resolveDueAt), '2026-11-30 10:00');        // 2700 min = 5 working days (+30 min)
});

test('pause: waiting time is added to the resolve deadline, reply deadline untouched', () => {
  const c = startCycle(engine, 'medium', ist('2026-11-20 17:00'));
  const paused = pausedMinutes(engine, ist('2026-11-20 17:20'), ist('2026-11-25 10:00'));
  assert.equal(paused, 1180);
  const due = dueDates(engine, { ...c, pausedBusinessMinutes: paused });
  assert.equal(fmt(due.resolveDueAt), '2026-11-30 09:40');      // 1620 + 1180 = 2800 min
  assert.equal(fmt(due.replyDueAt), '2026-11-23 12:30');        // unchanged
});

test('priority change: escalating keeps the clock start, so the ticket can be instantly late', () => {
  const c = startCycle(engine, 'medium', ist('2026-11-23 10:00'));
  const up = recomputeForPriority(engine, c, 'high', 0);
  assert.equal(up.priority, 'high');
  assert.equal(fmt(up.replyDueAt), '2026-11-23 12:00');         // from the ORIGINAL start, not from now
  assert.equal(up.resolveBudgetMinutes, 510);                   // 10:00 -> 18:30 on the start day
  assert.equal(fmt(up.resolveDueAt), '2026-11-23 18:30');
  assert.equal(isOverdue(up.resolveDueAt, ist('2026-11-25 09:00')), true);   // escalated on Wednesday
});

test('priority change: downgrading moves deadlines later and keeps pauses', () => {
  const c = startCycle(engine, 'high', ist('2026-11-23 10:00'));
  const down = recomputeForPriority(engine, c, 'low', 0);
  assert.equal(fmt(down.replyDueAt), '2026-11-24 10:00');
  assert.equal(fmt(down.resolveDueAt), '2026-11-30 10:00');
  const withPause = recomputeForPriority(engine, c, 'low', 540);
  assert.equal(fmt(withPause.resolveDueAt), '2026-12-01 10:00');   // one extra working day
});

test('priority change counts from the cycle clock start, not the real arrival time', () => {
  // Arrived 18:29:30: the clock started at 18:29 (floored). Escalating to High must still be due 18:30 today.
  const c = startCycle(engine, 'medium', ist('2026-11-23 18:29:30'));
  assert.equal(fmt(c.clockStartAt), '2026-11-23 18:29');
  const up = recomputeForPriority(engine, c, 'high', 0);
  assert.equal(up.resolveBudgetMinutes, 1);
  assert.equal(fmt(up.resolveDueAt), '2026-11-23 18:30');
});

test('priority change does not mutate the cycle it was given', () => {
  const c = Object.freeze(startCycle(engine, 'medium', ist('2026-11-23 10:00')));
  assert.doesNotThrow(() => recomputeForPriority(engine, c, 'high', 0));
});

test('auto-close and reopen windows are 5 working days', () => {
  // Waiting since Friday 17:20 -> next Friday 17:20.
  assert.equal(fmt(autoCloseAt(engine, ist('2026-11-20 17:20'))), '2026-11-27 17:20');
  // Resolved Wed 23 Dec 12:00; Dec 25 is a holiday -> reopen until Thu 31 Dec 12:00.
  assert.equal(fmt(reopenUntil(engine, ist('2026-12-23 12:00'))), '2026-12-31 12:00');
});

test('unknown priority is rejected', () => {
  assert.throws(() => startCycle(engine, 'urgent', ist('2026-11-23 10:00')), RangeError);
});
```

```js file=tests/engineConfig.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { holidays } from '../db/schema.js';
import { loadEngineConfig } from '../server/lib/engineConfig.js';
import { startCycle } from '../server/lib/sla.js';
import { createTestDb } from './helpers/testDb.js';
import { ist, fmt } from './helpers/time.js';

const ctx = await createTestDb();
test.after(() => ctx.drop());

test('loads policies, windows and calendar from the seeded tables', async () => {
  const engine = await loadEngineConfig(ctx.db);
  assert.deepEqual(engine.policies, {
    high:   { replyMinutes: 120, resolveMinutes: null, resolveSameDay: true },
    medium: { replyMinutes: 270, resolveMinutes: 1620, resolveSameDay: false },
    low:    { replyMinutes: 540, resolveMinutes: 2700, resolveSameDay: false },
  });
  assert.equal(engine.autoCloseMinutes, 2700);
  assert.equal(engine.reopenMinutes, 2700);
  assert.equal(engine.calendar.isWorkingDay(ist('2026-12-25 12:00')), false);   // seeded holiday
  assert.equal(engine.calendar.isWorkingDay(ist('2026-12-24 12:00')), true);
});

test('the loaded engine produces the Friday 6 PM answer end to end', async () => {
  const engine = await loadEngineConfig(ctx.db);
  const c = startCycle(engine, 'high', ist('2026-11-20 18:00'));
  assert.equal(fmt(c.replyDueAt), '2026-11-23 11:00');
});

test('holidays are editable data: a new row changes the calendar on the next load', async () => {
  await ctx.db.insert(holidays).values({ holidayDate: '2026-11-24', name: 'Test holiday' });
  const engine = await loadEngineConfig(ctx.db);
  assert.equal(engine.calendar.isWorkingDay(ist('2026-11-24 12:00')), false);
  // Mon 23 Nov 18:00 + 120 min: 30 min Monday, Tue is a holiday, 90 min Wed.
  assert.equal(fmt(engine.calendar.addBusinessMinutes(ist('2026-11-23 18:00'), 120)), '2026-11-25 11:00');
});

test('a missing setting fails loudly instead of silently using a default', async () => {
  await ctx.pool.query(`DELETE FROM settings WHERE key = 'work_end'`);
  await assert.rejects(loadEngineConfig(ctx.db), /work_end/);
});
```

**Verify (expected RED):** `npm test` now fails with `Cannot find module '../server/lib/calendar.js'`. That is correct. Do not stub the modules to silence it. Go to Step 2.

---

### Step 2: `server/lib/calendar.js`

Make `tests/calendar.test.js` pass. Follow this design (it is the part Copilot most often gets wrong):

1. **Do all arithmetic on epoch milliseconds, never with `Date` local-time methods.** No `setHours`, `getHours`, `toLocaleString`, `getDay`. The machine's own timezone must have no effect.
2. **Convert to a "local day number" once:** `localMs = utcMs + offsetMin * 60_000`, `day = floor(localMs / 86_400_000)`, `minuteOfDay = (localMs - day * 86_400_000) / 60_000`. Working with whole day numbers makes holiday and weekday checks trivial.
3. **ISO weekday from a day number:** day 0 (1970-01-01) was a Thursday, so `isoWeekday = ((((day + 3) % 7) + 7) % 7) + 1` (Mon = 1 … Sun = 7).
4. **Holiday key:** `new Date(day * 86_400_000).toISOString().slice(0, 10)` gives the local `YYYY-MM-DD` to look up in a `Set`.
5. **Back to an instant:** `utcMs = day * 86_400_000 + minute * 60_000 - offsetMin * 60_000`.
6. **`addBusinessMinutes` is a loop:** start at `nextOpening`. Ask "how much of today is left?" (`closeMs - t`). If the remaining work fits, return `t + remaining`. Otherwise subtract it and jump to the next opening after `closeMs`. Use `remaining <= available` (so an exact fit stays on that day).
7. **`businessMinutesBetween` is a day-by-day overlap sum:** for each local day from `a`'s day to `b`'s day that is a working day, add the overlap of `[a, b)` with `[open, close)`. Floor the total to whole minutes.
8. **Safety net:** every loop is capped (about 3,700 working days) and throws a clear error, both the scan for "the next working day" and the loop inside `addBusinessMinutes`. A calendar mistake must produce an error, never a hung test run.
9. Validate input in `createCalendar`: supported timezone, `workStart < workEnd`, at least one work day, `HH:MM` format.

Also export `toMs(value)` (accepts `Date`, number or ISO string, throws `TypeError` on garbage), `floorToMinute(value)` and `ZONE_OFFSETS = { 'Asia/Kolkata': 330, UTC: 0 }`.

**Verify:** `node --test tests/calendar.test.js` shows all pass.

---

### Step 3: `server/lib/sla.js`

Make `tests/sla.test.js` pass. This module only composes calendar functions; it must contain **no date arithmetic of its own** and **no database or Express imports**. Follow §2 and the API table in §4. Notes:

- Pull budgets out as a small function (`budgetsFor`) so `startCycle` and `recomputeForPriority` share it.
- `recomputeForPriority` takes the cycle's **existing** `clockStartAt` and returns a new object. It never writes to its input.
- Throw `RangeError` for an unknown priority.

**Verify:** `node --test tests/sla.test.js` shows all pass.

---

### Step 4: `server/lib/engineConfig.js`

Make `tests/engineConfig.test.js` pass. `loadEngineConfig(db)` reads the three tables with Drizzle (`settings`, `holidays`, `slaPolicies` from `db/schema.js`) and returns the `engine` object from §4.

- Settings are `key`/`value` text rows. Required keys: `timezone`, `work_start`, `work_end`, `work_days` (`"1,2,3,4,5"`), `auto_close_business_minutes`, `reopen_business_minutes`.
- A missing or non-numeric setting must throw an error **that names the key** (the test checks for `work_end`). Never fall back to a hard-coded default: a silently wrong calendar is worse than a crash.
- `holidays.holidayDate` is already a `'YYYY-MM-DD'` string (the schema uses `mode: 'string'`). Pass it straight to `createCalendar`.
- Policies map by `priority`. Convert nothing else: `resolveMinutes` stays `null` for High.
- No caching in this step. (Forty tickets a day does not need it, and a cache would hide holiday edits.)

**Verify:** `node --test tests/engineConfig.test.js` shows all pass.

---

### Step 5: Timezone independence, full suite, commit

The engine must not depend on the machine's timezone. Run the suite under unusual zones:

```bash
TZ=UTC npm test
TZ=America/Los_Angeles npm test
TZ=Pacific/Auckland npm test
npm test
```

All four runs must pass with the same counts. Then append the §3 rows to `docs/DECISIONS.md` and commit:

```bash
git add -A && git commit -m "step 2: business-time and SLA engine with tests"
```

---

## 6. Acceptance checklist

| # | Check | Expected |
|---|---|---|
| 1 | `npm test` | All files pass: Step 01's 14 tests plus 9 + 13 + 4 new ones (40 in total) |
| 2 | `TZ=America/Los_Angeles npm test` | Same result (no machine-timezone dependence) |
| 3 | `grep -rn "setHours\|getHours\|getDay\|toLocale" server/lib` | No matches |
| 4 | `grep -rn "import" server/lib/calendar.js server/lib/sla.js` | Only imports between these two files (no `db`, no `express`, no `drizzle-orm`) |
| 5 | Tests unmodified | `git diff tests/calendar.test.js tests/sla.test.js tests/engineConfig.test.js tests/helpers/time.js` is empty after Step 1's commit |
| 6 | Friday 6 PM, High | reply due Mon 11:00, and `isOverdue` is false on Sunday |
| 7 | Pause example | 1180 business minutes, resolve due moves to Mon 30 Nov 09:40 |
| 8 | `docs/DECISIONS.md` | Contains the 9 rows from §3 |

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Results are off by 5.5 hours | Used `Date` local methods or `toISOString().slice()` for local time | Work in epoch ms plus the 330-minute offset (§5 Step 2, points 1 and 2) |
| `Mon 09:30 + 540` returns Tuesday 09:30 | Jumped to the next day at exactly 18:30 | Use `remaining <= available` and return the closing time |
| Friday 18:00 + 120 min gives Monday 11:30 | Counted 18:30 to 19:00 as working time, or lost the 30 Friday minutes | Day interval is `[09:30, 18:30)`. Subtract the day's remaining time first |
| `nextOpening` at exactly 18:30 stays the same | Used `<=` for the closing check | At 18:30 the day is closed: use `minuteOfDay < endMin` |
| The property test fails near holidays | Loop skips a non-working day incorrectly | Re-check `isWorkingDayNumber` and the next-opening scan start (`day + 1`) |
| Test "invalid calendars" fails | Missing validation in `createCalendar` | See Step 2, point 9 |
| `engineConfig` test fails on holidays | Converted `holidayDate` to a `Date` | It is already a string; pass through |
| Copilot edits a test to make it pass | Violates the LOCKED rule | `git checkout tests/` and re-run |
| Infinite loop / test hangs | No scan cap, or a bad calendar | Add the day cap (Step 2, point 8) |

## 8. Out of scope for this step

Anything that touches tickets: creating cycles in the database, writing events, claiming, replying, pausing for real, the tick job, auth. **Step 03 (auth and ticket lifecycle) is next** and will call `startCycle`, `dueDates`, `recomputeForPriority`, `autoCloseAt`, `reopenUntil` and `pausedMinutes` from inside its transactions.

---

## Appendix: reference implementation (use ONLY if Copilot is stuck)

This passes every test above. Try the §5 guidance first. If a test still fails after two attempts, compare against this, and ask Copilot to explain the difference rather than pasting it blindly.

```js ref=server/lib/calendar.js
const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;
const MAX_SCAN_DAYS = 3700;   // ~10 years: a calendar with no working days must fail, not loop forever

// Fixed UTC offsets in minutes. Only add zones that have NO daylight saving.
export const ZONE_OFFSETS = Object.freeze({ 'Asia/Kolkata': 330, UTC: 0 });

export function toMs(value) {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`Invalid time value: ${String(value)}`);
  return ms;
}

export function floorToMinute(value) {
  return new Date(Math.floor(toMs(value) / MS_PER_MIN) * MS_PER_MIN);
}

function parseClock(text) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(text));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new RangeError(`Bad HH:MM value: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function createCalendar({
  timezone = 'Asia/Kolkata',
  workStart = '09:30',
  workEnd = '18:30',
  workDays = [1, 2, 3, 4, 5],
  holidays = [],
} = {}) {
  const offsetMin = ZONE_OFFSETS[timezone];
  if (offsetMin === undefined) throw new Error(`Unsupported timezone "${timezone}" (no fixed offset known)`);
  const startMin = parseClock(workStart);
  const endMin = parseClock(workEnd);
  if (startMin >= endMin) throw new RangeError('workStart must be before workEnd');
  const weekdays = new Set(workDays);
  if (weekdays.size === 0) throw new RangeError('workDays must not be empty');
  const holidaySet = new Set(holidays);

  // --- local-day arithmetic (all on epoch milliseconds, never Date local-time methods) ---
  const localMs = (ms) => ms + offsetMin * MS_PER_MIN;
  const dayOf = (ms) => Math.floor(localMs(ms) / MS_PER_DAY);
  const minuteOfDay = (ms) => (localMs(ms) - dayOf(ms) * MS_PER_DAY) / MS_PER_MIN;
  const instant = (day, minute) => day * MS_PER_DAY + minute * MS_PER_MIN - offsetMin * MS_PER_MIN;
  const isoWeekday = (day) => ((((day + 3) % 7) + 7) % 7) + 1;      // 1970-01-01 was a Thursday
  const dateString = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
  const isWorkingDayNumber = (day) => weekdays.has(isoWeekday(day)) && !holidaySet.has(dateString(day));

  function nextOpeningMs(ms) {
    const day = dayOf(ms);
    if (isWorkingDayNumber(day)) {
      const m = minuteOfDay(ms);
      if (m < startMin) return instant(day, startMin);
      if (m < endMin) return ms;                                    // half-open: 18:30 itself is closed
    }
    for (let d = day + 1; d <= day + MAX_SCAN_DAYS; d++) {
      if (isWorkingDayNumber(d)) return instant(d, startMin);
    }
    throw new Error('No working day found within 10 years: check the calendar settings');
  }

  function addBusinessMinutes(start, minutes) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
      throw new RangeError('minutes must be a non-negative finite number');
    }
    let t = nextOpeningMs(toMs(start));
    let remaining = minutes * MS_PER_MIN;
    for (let guard = 0; guard <= MAX_SCAN_DAYS; guard++) {            // one pass per working day
      const close = instant(dayOf(t), endMin);
      const available = close - t;
      if (remaining <= available) return new Date(t + remaining);   // exact fit stays on this day
      remaining -= available;
      t = nextOpeningMs(close);
    }
    throw new RangeError('Business-time span is too long (or the calendar is misconfigured)');
  }

  function businessMinutesBetween(from, to) {
    const a = toMs(from);
    const b = toMs(to);
    if (b <= a) return 0;
    let total = 0;
    for (let d = dayOf(a); d <= dayOf(b); d++) {
      if (!isWorkingDayNumber(d)) continue;
      const lo = Math.max(a, instant(d, startMin));
      const hi = Math.min(b, instant(d, endMin));
      if (hi > lo) total += hi - lo;
    }
    return Math.floor(total / MS_PER_MIN);
  }

  return Object.freeze({
    isWorkingDay: (t) => isWorkingDayNumber(dayOf(toMs(t))),
    nextOpening: (t) => new Date(nextOpeningMs(toMs(t))),
    addBusinessMinutes,
    businessMinutesBetween,
    closingTime: (t) => new Date(instant(dayOf(toMs(t)), endMin)),
    localDate: (t) => dateString(dayOf(toMs(t))),
  });
}
```

```js ref=server/lib/sla.js
import { toMs, floorToMinute } from './calendar.js';

function policyFor(engine, priority) {
  const policy = engine.policies[priority];
  if (!policy) throw new RangeError(`Unknown priority: ${priority}`);
  return policy;
}

export function budgetsFor(engine, priority, clockStartAt) {
  const policy = policyFor(engine, priority);
  const { calendar } = engine;
  const resolveBudgetMinutes = policy.resolveSameDay
    ? Math.max(1, calendar.businessMinutesBetween(clockStartAt, calendar.closingTime(clockStartAt)))
    : policy.resolveMinutes;
  return { replyBudgetMinutes: policy.replyMinutes, resolveBudgetMinutes };
}

// Pauses only ever extend the RESOLVE deadline (a ticket can only wait after a first reply).
export function dueDates(engine, { clockStartAt, replyBudgetMinutes, resolveBudgetMinutes, pausedBusinessMinutes = 0 }) {
  const { calendar } = engine;
  return {
    replyDueAt: calendar.addBusinessMinutes(clockStartAt, replyBudgetMinutes),
    resolveDueAt: calendar.addBusinessMinutes(clockStartAt, resolveBudgetMinutes + pausedBusinessMinutes),
  };
}

export function startCycle(engine, priority, arrivalAt) {
  const startedAt = new Date(toMs(arrivalAt));
  const clockStartAt = floorToMinute(engine.calendar.nextOpening(startedAt));
  const budgets = budgetsFor(engine, priority, clockStartAt);
  return { priority, startedAt, clockStartAt, ...budgets, ...dueDates(engine, { clockStartAt, ...budgets }) };
}

// Same clockStartAt, new budgets: elapsed time is kept, so escalation can make a ticket instantly late.
export function recomputeForPriority(engine, cycle, newPriority, pausedBusinessMinutes = 0) {
  const budgets = budgetsFor(engine, newPriority, cycle.clockStartAt);
  return {
    priority: newPriority,
    ...budgets,
    ...dueDates(engine, { clockStartAt: cycle.clockStartAt, ...budgets, pausedBusinessMinutes }),
  };
}

export const pausedMinutes = (engine, pausedAt, resumedAt) =>
  engine.calendar.businessMinutesBetween(pausedAt, resumedAt);

export const autoCloseAt = (engine, waitingSince) =>
  engine.calendar.addBusinessMinutes(waitingSince, engine.autoCloseMinutes);

export const reopenUntil = (engine, resolvedAt) =>
  engine.calendar.addBusinessMinutes(resolvedAt, engine.reopenMinutes);

// Strictly later than the due time: exactly at the deadline is not late.
export const isOverdue = (dueAt, now) => toMs(now) > toMs(dueAt);
```

```js ref=server/lib/engineConfig.js
import { settings, holidays, slaPolicies } from '../../db/schema.js';
import { createCalendar } from './calendar.js';

function requireSetting(map, key) {
  const value = map[key];
  if (value === undefined || value === '') throw new Error(`Missing required setting "${key}" in the settings table`);
  return value;
}

function requireNumber(map, key) {
  const n = Number(requireSetting(map, key));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Setting "${key}" must be a positive number`);
  return n;
}

export async function loadEngineConfig(db) {
  const [settingRows, holidayRows, policyRows] = await Promise.all([
    db.select().from(settings),
    db.select().from(holidays),
    db.select().from(slaPolicies),
  ]);
  const s = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));

  const calendar = createCalendar({
    timezone: requireSetting(s, 'timezone'),
    workStart: requireSetting(s, 'work_start'),
    workEnd: requireSetting(s, 'work_end'),
    workDays: requireSetting(s, 'work_days').split(',').map(Number),
    holidays: holidayRows.map((h) => h.holidayDate),
  });

  const policies = Object.fromEntries(policyRows.map((p) => [p.priority, {
    replyMinutes: p.replyMinutes,
    resolveMinutes: p.resolveMinutes,
    resolveSameDay: p.resolveSameDay,
  }]));

  return {
    calendar,
    policies,
    autoCloseMinutes: requireNumber(s, 'auto_close_business_minutes'),
    reopenMinutes: requireNumber(s, 'reopen_business_minutes'),
  };
}
```
