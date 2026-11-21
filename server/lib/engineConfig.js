import { holidays, settings, slaPolicies } from '../../db/schema.js';
import { createCalendar } from './calendar.js';

function requiredSetting(values, key) {
  const value = values.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or empty required setting: ${key}`);
  }
  return value;
}

function integerSetting(values, key) {
  const value = requiredSetting(values, key);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Setting "${key}" must be a non-negative integer`);
  }
  return number;
}

function workDaysSetting(values) {
  const key = 'work_days';
  const value = requiredSetting(values, key);
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Setting "${key}" must be a comma-separated list of ISO weekdays`);
  }
  const days = parts.map(Number);
  if (days.some((day) => day < 1 || day > 7)) {
    throw new Error(`Setting "${key}" must contain ISO weekdays from 1 to 7`);
  }
  return days;
}

export async function loadEngineConfig(db) {
  const [settingRows, holidayRows, policyRows] = await Promise.all([
    db.select().from(settings),
    db.select().from(holidays),
    db.select().from(slaPolicies),
  ]);
  const settingValues = new Map(settingRows.map(({ key, value }) => [key, value]));
  const timezone = requiredSetting(settingValues, 'timezone');
  const workStart = requiredSetting(settingValues, 'work_start');
  const workEnd = requiredSetting(settingValues, 'work_end');
  const workDays = workDaysSetting(settingValues);
  const autoCloseMinutes = integerSetting(settingValues, 'auto_close_business_minutes');
  const reopenMinutes = integerSetting(settingValues, 'reopen_business_minutes');

  const calendar = createCalendar({
    timezone,
    workStart,
    workEnd,
    workDays,
    holidays: holidayRows.map(({ holidayDate }) => holidayDate),
  });
  const policies = Object.fromEntries(policyRows.map((policy) => [
    policy.priority,
    {
      replyMinutes: policy.replyMinutes,
      resolveMinutes: policy.resolveMinutes,
      resolveSameDay: policy.resolveSameDay,
    },
  ]));

  return { calendar, policies, autoCloseMinutes, reopenMinutes };
}
