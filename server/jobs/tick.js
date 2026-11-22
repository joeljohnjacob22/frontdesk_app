import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from 'drizzle-orm';
import { slaCycles, slaPauses, tickets } from '../../db/schema.js';
import { pausedMinutes } from '../lib/sla.js';
import { dbClock } from '../services/tickets.js';
import { logEvent, SYSTEM } from '../services/events.js';

const LIVE_STATUSES = ['new', 'open'];

async function findCandidates(db, now) {
  return db.selectDistinct({ id: tickets.id })
    .from(tickets)
    .leftJoin(slaCycles, and(
      eq(slaCycles.ticketId, tickets.id),
      isNull(slaCycles.endedAt),
    ))
    .where(or(
      and(
        eq(tickets.status, 'waiting_on_customer'),
        lte(tickets.autoCloseAt, now),
      ),
      and(
        eq(tickets.status, 'resolved'),
        lte(tickets.reopenUntil, now),
      ),
      and(
        inArray(tickets.status, LIVE_STATUSES),
        isNotNull(slaCycles.id),
        isNull(slaCycles.firstResponseAt),
        isNull(slaCycles.replyBreachedAt),
        lte(slaCycles.replyDueAt, now),
      ),
      and(
        inArray(tickets.status, LIVE_STATUSES),
        isNotNull(slaCycles.id),
        isNull(slaCycles.resolveBreachedAt),
        lte(slaCycles.resolveDueAt, now),
      ),
    ))
    .orderBy(asc(tickets.id));
}

async function closeWaitingTicket(tx, engine, ticket, cycle, now) {
  const [closed] = await tx.update(tickets).set({
    status: 'closed',
    closedAt: now,
    closedReason: 'customer_no_reply',
    waitingSince: null,
    autoCloseAt: null,
    updatedAt: now,
  }).where(and(
    eq(tickets.id, ticket.id),
    eq(tickets.status, 'waiting_on_customer'),
    lte(tickets.autoCloseAt, now),
  )).returning();
  if (!closed) return false;

  const [pause] = await tx.select().from(slaPauses)
    .where(and(eq(slaPauses.cycleId, cycle.id), isNull(slaPauses.resumedAt)))
    .for('update');
  if (!pause) throw new Error(`Waiting ticket ${ticket.id} has no open SLA pause`);

  const duration = pausedMinutes(engine, pause.pausedAt, now);
  await tx.update(slaPauses).set({
    resumedAt: now,
    businessMinutes: duration,
  }).where(eq(slaPauses.id, pause.id));
  const [endedCycle] = await tx.update(slaCycles).set({ endedAt: now })
    .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.endedAt)))
    .returning({ id: slaCycles.id });
  if (!endedCycle) throw new Error(`SLA cycle ${cycle.id} ended during auto-close`);

  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'auto_closed',
    actor: SYSTEM,
    payload: { reason: 'customer_no_reply' },
  });
  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'status_changed',
    actor: SYSTEM,
    payload: { from: 'waiting_on_customer', to: 'closed' },
  });
  return true;
}

async function closeResolvedTicket(tx, ticket, now) {
  const [closed] = await tx.update(tickets).set({
    status: 'closed',
    closedAt: now,
    closedReason: 'resolution_window_elapsed',
    updatedAt: now,
  }).where(and(
    eq(tickets.id, ticket.id),
    eq(tickets.status, 'resolved'),
    lte(tickets.reopenUntil, now),
  )).returning();
  if (!closed) return false;

  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'closed',
    actor: SYSTEM,
    payload: { reason: 'resolution_window_elapsed' },
  });
  return true;
}

async function recordBreaches(tx, ticket, cycle, now) {
  if (!LIVE_STATUSES.includes(ticket.status)) return false;
  let changed = false;

  if (cycle.firstResponseAt === null
      && cycle.replyBreachedAt === null
      && cycle.replyDueAt <= now) {
    const [updated] = await tx.update(slaCycles).set({ replyBreachedAt: now })
      .where(and(
        eq(slaCycles.id, cycle.id),
        isNull(slaCycles.endedAt),
        isNull(slaCycles.firstResponseAt),
        isNull(slaCycles.replyBreachedAt),
        lte(slaCycles.replyDueAt, now),
      ))
      .returning({ id: slaCycles.id });
    if (updated) {
      changed = true;
      await logEvent(tx, {
        ticketId: ticket.id,
        type: 'reply_breached',
        actor: SYSTEM,
        payload: { due_at: cycle.replyDueAt.toISOString(), detected_by: 'tick' },
      });
    }
  }

  if (cycle.resolveBreachedAt === null && cycle.resolveDueAt <= now) {
    const [updated] = await tx.update(slaCycles).set({ resolveBreachedAt: now })
      .where(and(
        eq(slaCycles.id, cycle.id),
        isNull(slaCycles.endedAt),
        isNull(slaCycles.resolveBreachedAt),
        lte(slaCycles.resolveDueAt, now),
      ))
      .returning({ id: slaCycles.id });
    if (updated) {
      changed = true;
      await logEvent(tx, {
        ticketId: ticket.id,
        type: 'resolve_breached',
        actor: SYSTEM,
        payload: { due_at: cycle.resolveDueAt.toISOString(), detected_by: 'tick' },
      });
    }
  }

  return changed;
}

async function processTicket(db, engine, ticketId, now) {
  return db.transaction(async (tx) => {
    const [ticket] = await tx.select().from(tickets)
      .where(eq(tickets.id, ticketId))
      .for('update', { skipLocked: true });
    if (!ticket) return 'skipped';

    if (ticket.status === 'waiting_on_customer' && ticket.autoCloseAt <= now) {
      const [cycle] = await tx.select().from(slaCycles)
        .where(and(eq(slaCycles.ticketId, ticket.id), isNull(slaCycles.endedAt)))
        .for('update');
      if (!cycle) throw new Error(`Waiting ticket ${ticket.id} has no active SLA cycle`);
      return await closeWaitingTicket(tx, engine, ticket, cycle, now) ? 'auto_closed' : 'unchanged';
    }

    if (ticket.status === 'resolved' && ticket.reopenUntil <= now) {
      return await closeResolvedTicket(tx, ticket, now) ? 'closed' : 'unchanged';
    }

    if (!LIVE_STATUSES.includes(ticket.status)) return 'unchanged';
    const [cycle] = await tx.select().from(slaCycles)
      .where(and(eq(slaCycles.ticketId, ticket.id), isNull(slaCycles.endedAt)))
      .for('update');
    if (!cycle) throw new Error(`Active ticket ${ticket.id} has no active SLA cycle`);
    return await recordBreaches(tx, ticket, cycle, now) ? 'breached' : 'unchanged';
  });
}

export async function runTick(db, engine, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('runTick requires a valid Date');
  }
  const candidates = await findCandidates(db, now);
  const result = { candidates: candidates.length, processed: 0, skipped: 0, changed: 0 };
  for (const { id } of candidates) {
    const outcome = await processTicket(db, engine, id, now);
    if (outcome === 'skipped') result.skipped += 1;
    else {
      result.processed += 1;
      if (outcome !== 'unchanged') result.changed += 1;
    }
  }
  return result;
}

export function startTickJob({
  db,
  getEngine,
  intervalMs,
  clock = dbClock,
  logger = console,
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Tick interval must be a positive integer');
  }

  let inFlight = null;
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await runTick(db, await getEngine(), await clock(db));
      } catch (error) {
        logger.error('SLA tick failed:', error.cause?.message ?? error.stack ?? error);
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();

  return async function stopTickJob() {
    clearInterval(timer);
    if (inFlight) await inFlight;
  };
}
