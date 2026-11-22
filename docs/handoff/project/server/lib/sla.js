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
