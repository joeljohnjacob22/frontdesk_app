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
