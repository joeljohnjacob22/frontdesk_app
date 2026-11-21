import { floorToMinute, toMs } from './calendar.js';

export function budgetsFor(engine, priority, clockStartAt) {
  if (!Object.hasOwn(engine.policies, priority)) {
    throw new RangeError(`Unknown SLA priority: ${priority}`);
  }
  const policy = engine.policies[priority];
  const resolveBudgetMinutes = policy.resolveSameDay
    ? Math.max(1, engine.calendar.businessMinutesBetween(
      clockStartAt,
      engine.calendar.closingTime(clockStartAt),
    ))
    : policy.resolveMinutes;

  return {
    replyBudgetMinutes: policy.replyMinutes,
    resolveBudgetMinutes,
  };
}

export function dueDates(engine, {
  clockStartAt,
  replyBudgetMinutes,
  resolveBudgetMinutes,
  pausedBusinessMinutes = 0,
}) {
  return {
    replyDueAt: engine.calendar.addBusinessMinutes(clockStartAt, replyBudgetMinutes),
    resolveDueAt: engine.calendar.addBusinessMinutes(
      clockStartAt,
      resolveBudgetMinutes + pausedBusinessMinutes,
    ),
  };
}

export function startCycle(engine, priority, arrivalAt) {
  const startedAt = new Date(toMs(arrivalAt));
  const clockStartAt = floorToMinute(engine.calendar.nextOpening(arrivalAt));
  const budgets = budgetsFor(engine, priority, clockStartAt);
  const dates = dueDates(engine, { clockStartAt, ...budgets });
  return {
    priority,
    startedAt,
    clockStartAt,
    ...budgets,
    ...dates,
  };
}

export function recomputeForPriority(engine, cycle, newPriority, pausedBusinessMinutes = 0) {
  const budgets = budgetsFor(engine, newPriority, cycle.clockStartAt);
  const dates = dueDates(engine, {
    clockStartAt: cycle.clockStartAt,
    ...budgets,
    pausedBusinessMinutes,
  });
  return {
    priority: newPriority,
    ...budgets,
    ...dates,
  };
}

export function pausedMinutes(engine, pausedAt, resumedAt) {
  return engine.calendar.businessMinutesBetween(pausedAt, resumedAt);
}

export function autoCloseAt(engine, waitingSince) {
  return engine.calendar.addBusinessMinutes(waitingSince, engine.autoCloseMinutes);
}

export function reopenUntil(engine, resolvedAt) {
  return engine.calendar.addBusinessMinutes(resolvedAt, engine.reopenMinutes);
}

export function isOverdue(dueAt, now) {
  return toMs(now) > toMs(dueAt);
}
