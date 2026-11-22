import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  customers,
  messages,
  slaCycles,
  slaPauses,
  tickets,
  users,
} from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { bodyHash, hashToken, newToken } from '../lib/tokens.js';
import {
  autoCloseAt,
  dueDates,
  isOverdue,
  pausedMinutes,
  reopenUntil,
  recomputeForPriority,
  startCycle,
} from '../lib/sla.js';
import { customerActor, logEvent, staffActor, SYSTEM } from './events.js';

const CLAIMABLE_STATUSES = ['new', 'open', 'waiting_on_customer'];
const OPEN_STATUSES = ['open', 'waiting_on_customer'];

export function dbClock(tx) {
  return tx.execute(sql`select clock_timestamp() as now`)
    .then((result) => new Date(result.rows[0].now));
}

function missingTicket() {
  return new HttpError(404, 'ticket_not_found', 'Ticket not found');
}

function ticketConflict(code, message) {
  return new HttpError(409, code, message);
}

function forbidden(message = 'You are not allowed to perform this action') {
  return new HttpError(403, 'forbidden', message);
}

function statusChangedPayload(from, to) {
  return { from, to };
}

async function lockTicket(tx, ticketId) {
  const [ticket] = await tx.select().from(tickets)
    .where(eq(tickets.id, ticketId))
    .for('update');
  if (!ticket) throw missingTicket();
  return ticket;
}

async function activeCycle(tx, ticketId) {
  const [cycle] = await tx.select().from(slaCycles)
    .where(and(eq(slaCycles.ticketId, ticketId), isNull(slaCycles.endedAt)))
    .for('update');
  if (!cycle) throw new Error(`Ticket ${ticketId} has no active SLA cycle`);
  return cycle;
}

async function finishedPauseMinutes(tx, ticketId) {
  const pauses = await tx.select({ businessMinutes: slaPauses.businessMinutes })
    .from(slaPauses)
    .where(eq(slaPauses.ticketId, ticketId));
  return pauses.reduce((sum, pause) => sum + (pause.businessMinutes ?? 0), 0);
}

async function insertMessage(tx, values) {
  const [message] = await tx.insert(messages).values(values).returning();
  return message;
}

async function insertCycle(tx, engine, {
  ticketId,
  priority,
  now,
  cycleNo = 1,
  isReopen = false,
}) {
  const calculated = startCycle(engine, priority, now);
  const [cycle] = await tx.insert(slaCycles).values({
    ticketId,
    cycleNo,
    isReopen,
    startedAt: now,
    clockStartAt: calculated.clockStartAt,
    priority,
    replyBudgetMinutes: calculated.replyBudgetMinutes,
    resolveBudgetMinutes: calculated.resolveBudgetMinutes,
    replyDueAt: calculated.replyDueAt,
    resolveDueAt: calculated.resolveDueAt,
  }).returning();
  await logEvent(tx, {
    ticketId,
    type: 'sla_cycle_started',
    actor: SYSTEM,
    payload: {
      cycle_no: cycleNo,
      is_reopen: isReopen,
      priority,
      reply_due_at: calculated.replyDueAt.toISOString(),
      resolve_due_at: calculated.resolveDueAt.toISOString(),
    },
  });
  return cycle;
}

async function createTicketInTx(tx, engine, now, customer, {
  subject,
  body,
  priority,
  parentTicketId = null,
}) {
  const token = newToken();
  const [ticket] = await tx.insert(tickets).values({
    customerId: customer.id,
    subject,
    priority,
    parentTicketId,
    accessTokenHash: hashToken(token),
    createdAt: now,
    updatedAt: now,
  }).returning();
  const message = await insertMessage(tx, {
    ticketId: ticket.id,
    kind: 'public',
    authorType: 'customer',
    authorCustomerId: customer.id,
    body,
    createdAt: now,
  });
  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'ticket_created',
    actor: customerActor(customer.id),
    messageId: message.id,
    payload: { ticket_no: ticket.ticketNo, body_sha256: bodyHash(body) },
  });
  await insertCycle(tx, engine, {
    ticketId: ticket.id,
    priority,
    now,
  });
  if (parentTicketId !== null) {
    await logEvent(tx, {
      ticketId: ticket.id,
      type: 'linked_ticket_created',
      actor: customerActor(customer.id),
      payload: { parent_ticket_id: parentTicketId },
    });
  }
  return { ticket, token };
}

function isOwner(ticket, user) {
  return ticket.assigneeId !== null && ticket.assigneeId === user.id;
}

function assertOwnerOrLead(ticket, user) {
  if (user.role !== 'lead' && !isOwner(ticket, user)) throw forbidden();
}

function assertActiveStatus(ticket, allowedStatuses = CLAIMABLE_STATUSES) {
  if (!allowedStatuses.includes(ticket.status)) {
    throw ticketConflict('ticket_closed', 'Ticket is no longer active');
  }
}

export function createTicketService({ db, getEngine, clock = dbClock }) {
  async function inTx(operation) {
    const engine = await getEngine();
    return db.transaction(async (tx) => {
      const now = await clock(tx);
      return operation(tx, engine, now);
    });
  }

  async function createTicket(input) {
    return inTx(async (tx, engine, now) => {
      await tx.insert(customers).values({
        name: input.name,
        email: input.email,
      }).onConflictDoNothing();
      const [customer] = await tx.select().from(customers)
        .where(sql`lower(${customers.email}) = ${input.email.toLowerCase()}`);
      if (!customer) throw new Error('Customer upsert did not return a customer');
      return createTicketInTx(tx, engine, now, customer, {
        subject: input.subject,
        body: input.body,
        priority: input.priority,
      });
    });
  }

  async function claimTicket(ticketId, user) {
    return inTx(async (tx, _engine, now) => {
      const ticket = await lockTicket(tx, ticketId);
      if (ticket.assigneeId !== null) {
        throw ticketConflict('already_claimed', 'Ticket is already assigned');
      }
      if (!CLAIMABLE_STATUSES.includes(ticket.status)) {
        throw ticketConflict('not_claimable', 'Ticket cannot be claimed in its current state');
      }
      const status = ticket.status === 'new' ? 'open' : ticket.status;
      const [claimed] = await tx.update(tickets).set({
        assigneeId: user.id,
        claimedAt: now,
        status,
        updatedAt: now,
      }).where(and(
        eq(tickets.id, ticketId),
        isNull(tickets.assigneeId),
        inArray(tickets.status, CLAIMABLE_STATUSES),
      )).returning();
      if (!claimed) {
        throw ticketConflict('already_claimed', 'Ticket is already assigned');
      }
      await logEvent(tx, {
        ticketId,
        type: 'claimed',
        actor: staffActor(user),
        payload: { status_after: claimed.status },
      });
      return claimed;
    });
  }

  async function releaseTicket(ticketId, user) {
    return inTx(async (tx, _engine, now) => {
      const ticket = await lockTicket(tx, ticketId);
      if (ticket.assigneeId === null) {
        throw ticketConflict('not_assigned', 'Ticket is not assigned');
      }
      if (user.role !== 'lead' && !isOwner(ticket, user)) throw forbidden();
      const [released] = await tx.update(tickets).set({
        assigneeId: null,
        updatedAt: now,
      }).where(eq(tickets.id, ticketId)).returning();
      await logEvent(tx, {
        ticketId,
        type: 'released',
        actor: staffActor(user),
        payload: { from_user_id: ticket.assigneeId, by_lead: user.role === 'lead' },
      });
      return released;
    });
  }

  async function reassignTicket(ticketId, user, toUserId) {
    return inTx(async (tx, _engine, now) => {
      const ticket = await lockTicket(tx, ticketId);
      if (user.role !== 'lead') throw forbidden();
      if (!CLAIMABLE_STATUSES.includes(ticket.status)) {
        throw ticketConflict('not_claimable', 'Ticket cannot be reassigned in its current state');
      }
      const [target] = await tx.select().from(users)
        .where(eq(users.id, toUserId));
      if (!target || !target.active || target.role !== 'agent') {
        throw new HttpError(400, 'validation_error', 'Target must be an active agent');
      }
      const [reassigned] = await tx.update(tickets).set({
        assigneeId: target.id,
        claimedAt: now,
        status: ticket.status === 'new' ? 'open' : ticket.status,
        updatedAt: now,
      }).where(eq(tickets.id, ticketId)).returning();
      await logEvent(tx, {
        ticketId,
        type: 'reassigned',
        actor: staffActor(user),
        payload: { from_user_id: ticket.assigneeId, to_user_id: target.id },
      });
      return reassigned;
    });
  }

  async function addNote(ticketId, user, body) {
    return inTx(async (tx, _engine, now) => {
      await lockTicket(tx, ticketId);
      const message = await insertMessage(tx, {
        ticketId,
        kind: 'note',
        authorType: 'staff',
        authorUserId: user.id,
        body,
        createdAt: now,
      });
      await logEvent(tx, {
        ticketId,
        type: 'note_added',
        actor: staffActor(user),
        messageId: message.id,
        payload: { body_sha256: bodyHash(body) },
      });
      return message;
    });
  }

  async function replyPublic(ticketId, user, { body, setWaiting = false }) {
    return inTx(async (tx, engine, now) => {
      const ticket = await lockTicket(tx, ticketId);
      if (ticket.assigneeId === null) {
        throw ticketConflict('claim_required', 'Ticket must be claimed before replying');
      }
      if (!isOwner(ticket, user)) {
        throw new HttpError(403, 'not_owner', 'Only the ticket owner may reply');
      }
      assertActiveStatus(ticket, OPEN_STATUSES);
      const cycle = await activeCycle(tx, ticketId);
      const message = await insertMessage(tx, {
        ticketId,
        kind: 'public',
        authorType: 'staff',
        authorUserId: user.id,
        body,
        createdAt: now,
      });
      const firstResponse = cycle.firstResponseAt === null;
      if (firstResponse) {
        await tx.update(slaCycles).set({
          firstResponseAt: now,
          firstResponseMessageId: message.id,
        }).where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.firstResponseAt)));
      }
      await logEvent(tx, {
        ticketId,
        type: 'public_reply_sent',
        actor: staffActor(user),
        messageId: message.id,
        payload: { body_sha256: bodyHash(body), first_response: firstResponse },
      });

      if (firstResponse && cycle.replyBreachedAt === null && isOverdue(cycle.replyDueAt, now)) {
        const [breached] = await tx.update(slaCycles).set({ replyBreachedAt: now })
          .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.replyBreachedAt)))
          .returning({ id: slaCycles.id });
        if (breached) {
          await logEvent(tx, {
            ticketId,
            type: 'reply_breached',
            actor: staffActor(user),
            messageId: message.id,
            payload: { due_at: cycle.replyDueAt.toISOString(), body_sha256: bodyHash(body) },
          });
        }
      }

      let updatedTicket = ticket;
      if (setWaiting && ticket.status === 'open') {
        const autoClose = autoCloseAt(engine, now);
        [updatedTicket] = await tx.update(tickets).set({
          status: 'waiting_on_customer',
          waitingSince: now,
          autoCloseAt: autoClose,
          updatedAt: now,
        }).where(eq(tickets.id, ticketId)).returning();
        await tx.insert(slaPauses).values({
          cycleId: cycle.id,
          ticketId,
          pausedAt: now,
        });
        await logEvent(tx, {
          ticketId,
          type: 'status_changed',
          actor: staffActor(user),
          payload: statusChangedPayload(ticket.status, 'waiting_on_customer'),
        });
        await logEvent(tx, {
          ticketId,
          type: 'sla_paused',
          actor: staffActor(user),
          payload: {},
        });
      }
      return { message, ticket: updatedTicket };
    });
  }

  async function setPriority(ticketId, user, priority) {
    return inTx(async (tx, engine, now) => {
      const ticket = await lockTicket(tx, ticketId);
      assertOwnerOrLead(ticket, user);
      assertActiveStatus(ticket);
      if (ticket.priority === priority) return ticket;

      const cycle = await activeCycle(tx, ticketId);
      const totalPausedMinutes = await finishedPauseMinutes(tx, ticketId);
      const updatedCycle = recomputeForPriority(engine, cycle, priority, totalPausedMinutes);
      const [changedCycle] = await tx.update(slaCycles).set({
        priority: updatedCycle.priority,
        replyBudgetMinutes: updatedCycle.replyBudgetMinutes,
        resolveBudgetMinutes: updatedCycle.resolveBudgetMinutes,
        replyDueAt: updatedCycle.replyDueAt,
        resolveDueAt: updatedCycle.resolveDueAt,
      }).where(eq(slaCycles.id, cycle.id)).returning();
      const [changedTicket] = await tx.update(tickets).set({
        priority,
        updatedAt: now,
      }).where(eq(tickets.id, ticketId)).returning();
      await logEvent(tx, {
        ticketId,
        type: 'priority_changed',
        actor: staffActor(user),
        payload: {
          from: ticket.priority,
          to: priority,
          old_reply_due_at: cycle.replyDueAt.toISOString(),
          new_reply_due_at: changedCycle.replyDueAt.toISOString(),
          old_resolve_due_at: cycle.resolveDueAt.toISOString(),
          new_resolve_due_at: changedCycle.resolveDueAt.toISOString(),
        },
      });
      return changedTicket;
    });
  }

  async function resolveTicket(ticketId, user) {
    return inTx(async (tx, engine, now) => {
      const ticket = await lockTicket(tx, ticketId);
      if (!isOwner(ticket, user)) {
        throw new HttpError(403, 'not_owner', 'Only the ticket owner may resolve it');
      }
      assertActiveStatus(ticket, OPEN_STATUSES);
      const cycle = await activeCycle(tx, ticketId);
      let judgedAt = now;
      const [pause] = await tx.select().from(slaPauses)
        .where(and(eq(slaPauses.cycleId, cycle.id), isNull(slaPauses.resumedAt)))
        .for('update');
      if (ticket.status === 'waiting_on_customer') {
        if (!pause) throw new Error(`Waiting ticket ${ticketId} has no open SLA pause`);
        const duration = pausedMinutes(engine, pause.pausedAt, now);
        await tx.update(slaPauses).set({
          resumedAt: now,
          businessMinutes: duration,
        }).where(eq(slaPauses.id, pause.id));
        judgedAt = pause.pausedAt;
        await logEvent(tx, {
          ticketId,
          type: 'sla_resumed',
          actor: staffActor(user),
          payload: { business_minutes: duration },
        });
      }

      if (cycle.firstResponseAt === null && cycle.replyBreachedAt === null
          && isOverdue(cycle.replyDueAt, judgedAt)) {
        const [breached] = await tx.update(slaCycles).set({ replyBreachedAt: judgedAt })
          .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.replyBreachedAt)))
          .returning({ id: slaCycles.id });
        if (breached) {
          await logEvent(tx, {
            ticketId,
            type: 'reply_breached',
            actor: staffActor(user),
            payload: { due_at: cycle.replyDueAt.toISOString() },
          });
        }
      }
      if (cycle.resolveBreachedAt === null && isOverdue(cycle.resolveDueAt, judgedAt)) {
        const [breached] = await tx.update(slaCycles).set({ resolveBreachedAt: judgedAt })
          .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.resolveBreachedAt)))
          .returning({ id: slaCycles.id });
        if (breached) {
          await logEvent(tx, {
            ticketId,
            type: 'resolve_breached',
            actor: staffActor(user),
            payload: { due_at: cycle.resolveDueAt.toISOString() },
          });
        }
      }

      const reopenDeadline = reopenUntil(engine, now);
      await tx.update(slaCycles).set({ resolvedAt: now, endedAt: now })
        .where(eq(slaCycles.id, cycle.id));
      const [resolved] = await tx.update(tickets).set({
        status: 'resolved',
        waitingSince: null,
        autoCloseAt: null,
        resolvedAt: now,
        reopenUntil: reopenDeadline,
        updatedAt: now,
      }).where(eq(tickets.id, ticketId)).returning();
      await logEvent(tx, {
        ticketId,
        type: 'resolved',
        actor: staffActor(user),
        payload: { reopen_until: reopenDeadline.toISOString() },
      });
      await logEvent(tx, {
        ticketId,
        type: 'status_changed',
        actor: staffActor(user),
        payload: statusChangedPayload(ticket.status, 'resolved'),
      });
      return resolved;
    });
  }

  async function customerMessage(token, body) {
    return inTx(async (tx, engine, now) => {
      const [ticket] = await tx.select().from(tickets)
        .where(eq(tickets.accessTokenHash, hashToken(token)))
        .for('update');
      if (!ticket) throw missingTicket();
      const actor = customerActor(ticket.customerId);

      if (ticket.status === 'new' || ticket.status === 'open' || ticket.status === 'waiting_on_customer') {
        const cycle = await activeCycle(tx, ticket.id);
        const message = await insertMessage(tx, {
          ticketId: ticket.id,
          kind: 'public',
          authorType: 'customer',
          authorCustomerId: ticket.customerId,
          recipientUserId: ticket.assigneeId,
          body,
          createdAt: now,
        });
        let updatedTicket = ticket;
        let resumed = false;
        if (ticket.status === 'waiting_on_customer') {
          const [pause] = await tx.select().from(slaPauses)
            .where(and(eq(slaPauses.cycleId, cycle.id), isNull(slaPauses.resumedAt)))
            .for('update');
          if (!pause) throw new Error(`Waiting ticket ${ticket.id} has no open SLA pause`);
          const duration = pausedMinutes(engine, pause.pausedAt, now);
          await tx.update(slaPauses).set({
            resumedAt: now,
            businessMinutes: duration,
          }).where(eq(slaPauses.id, pause.id));
          const totalPausedMinutes = await finishedPauseMinutes(tx, ticket.id);
          const updatedDates = dueDates(engine, {
            clockStartAt: cycle.clockStartAt,
            replyBudgetMinutes: cycle.replyBudgetMinutes,
            resolveBudgetMinutes: cycle.resolveBudgetMinutes,
            pausedBusinessMinutes: totalPausedMinutes,
          });
          await tx.update(slaCycles).set({
            resolveDueAt: updatedDates.resolveDueAt,
          }).where(eq(slaCycles.id, cycle.id));
          [updatedTicket] = await tx.update(tickets).set({
            status: 'open',
            waitingSince: null,
            autoCloseAt: null,
            updatedAt: now,
          }).where(eq(tickets.id, ticket.id)).returning();
          resumed = true;
          await logEvent(tx, {
            ticketId: ticket.id,
            type: 'sla_resumed',
            actor,
            payload: { business_minutes: duration },
          });
          await logEvent(tx, {
            ticketId: ticket.id,
            type: 'status_changed',
            actor,
            payload: statusChangedPayload('waiting_on_customer', 'open'),
          });
        }
        await logEvent(tx, {
          ticketId: ticket.id,
          type: 'customer_replied',
          actor,
          messageId: message.id,
          payload: { body_sha256: bodyHash(body), resumed_sla: resumed },
        });
        return { outcome: 'replied', ticket: updatedTicket };
      }

      if (ticket.status === 'resolved' && ticket.reopenUntil !== null
          && !isOverdue(ticket.reopenUntil, now)) {
        const message = await insertMessage(tx, {
          ticketId: ticket.id,
          kind: 'public',
          authorType: 'customer',
          authorCustomerId: ticket.customerId,
          recipientUserId: ticket.assigneeId,
          body,
          createdAt: now,
        });
        const [latestCycle] = await tx.select().from(slaCycles)
          .where(eq(slaCycles.ticketId, ticket.id))
          .orderBy(desc(slaCycles.cycleNo))
          .limit(1);
        if (!latestCycle) throw new Error(`Resolved ticket ${ticket.id} has no SLA cycle`);
        const [reopened] = await tx.update(tickets).set({
          status: 'open',
          reopenCount: ticket.reopenCount + 1,
          resolvedAt: null,
          reopenUntil: null,
          updatedAt: now,
        }).where(eq(tickets.id, ticket.id)).returning();
        await logEvent(tx, {
          ticketId: ticket.id,
          type: 'customer_replied',
          actor,
          messageId: message.id,
          payload: { body_sha256: bodyHash(body) },
        });
        await logEvent(tx, {
          ticketId: ticket.id,
          type: 'reopened',
          actor,
          payload: { reopen_count: reopened.reopenCount },
        });
        await logEvent(tx, {
          ticketId: ticket.id,
          type: 'status_changed',
          actor,
          payload: statusChangedPayload('resolved', 'open'),
        });
        await insertCycle(tx, engine, {
          ticketId: ticket.id,
          priority: ticket.priority,
          now,
          cycleNo: latestCycle.cycleNo + 1,
          isReopen: true,
        });
        return { outcome: 'reopened', ticket: reopened };
      }

      const [customer] = await tx.select().from(customers)
        .where(eq(customers.id, ticket.customerId));
      if (!customer) throw new Error(`Ticket ${ticket.id} has no customer`);
      const subject = ticket.subject.startsWith('Re: ')
        ? ticket.subject
        : `Re: ${ticket.subject}`;
      const child = await createTicketInTx(tx, engine, now, customer, {
        subject,
        body,
        priority: ticket.priority,
        parentTicketId: ticket.id,
      });
      await logEvent(tx, {
        ticketId: ticket.id,
        type: 'linked_ticket_created',
        actor,
        payload: { child_ticket_id: child.ticket.id },
      });
      return { outcome: 'new_ticket', ticket: child.ticket, token: child.token };
    });
  }

  return {
    createTicket,
    claimTicket,
    releaseTicket,
    reassignTicket,
    addNote,
    replyPublic,
    setPriority,
    resolveTicket,
    customerMessage,
  };
}
