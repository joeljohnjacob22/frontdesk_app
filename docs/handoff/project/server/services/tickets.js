import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { customers, messages, slaCycles, slaPauses, tickets, users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { iso } from '../lib/format.js';
import { bodyHash, hashToken, newToken } from '../lib/tokens.js';
import {
  autoCloseAt, dueDates, isOverdue, pausedMinutes, recomputeForPriority, reopenUntil, startCycle,
} from '../lib/sla.js';
import { SYSTEM, customerActor, logEvent, staffActor } from './events.js';

// Default time source: the DATABASE clock, so every timestamp has one authority (INC-0318).
// Tests inject a fake clock instead.
export const dbClock = async (tx) => {
  const result = await tx.execute(sql`select clock_timestamp() as t`);
  return new Date(result.rows[0].t);
};

const ACTIVE = ['new', 'open', 'waiting_on_customer'];

export function createTicketService({ db, getEngine, clock = dbClock }) {
  // One transaction + one engine snapshot + one "now" per operation.
  async function inTx(fn) {
    const engine = await getEngine();
    return db.transaction(async (tx) => fn(tx, engine, await clock(tx)));
  }

  async function lockTicket(tx, id) {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, id)).for('update');
    if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
    return ticket;
  }

  async function activeCycle(tx, ticketId) {
    const [cycle] = await tx.select().from(slaCycles)
      .where(and(eq(slaCycles.ticketId, ticketId), isNull(slaCycles.endedAt))).limit(1);
    if (!cycle) throw new Error(`Ticket ${ticketId} has no active SLA cycle`);
    return cycle;
  }

  async function openPause(tx, cycleId) {
    const [pause] = await tx.select().from(slaPauses)
      .where(and(eq(slaPauses.cycleId, cycleId), isNull(slaPauses.resumedAt))).limit(1);
    return pause ?? null;
  }

  async function closedPauseMinutes(tx, cycleId) {
    const [row] = await tx
      .select({ total: sql`coalesce(sum(${slaPauses.businessMinutes}), 0)::int` })
      .from(slaPauses)
      .where(and(eq(slaPauses.cycleId, cycleId), isNotNull(slaPauses.resumedAt)));
    return Number(row.total);
  }

  async function insertMessage(tx, { ticketId, kind, actor, body, recipientUserId = null, at }) {
    const [message] = await tx.insert(messages).values({
      ticketId,
      kind,
      authorType: actor.type,
      authorUserId: actor.userId ?? null,
      authorCustomerId: actor.customerId ?? null,
      recipientUserId,
      body,
      createdAt: at,
    }).returning();
    return message;
  }

  async function startSlaCycle(tx, engine, ticket, cycleNo, isReopen, at) {
    const c = startCycle(engine, ticket.priority, at);
    const [cycle] = await tx.insert(slaCycles).values({
      ticketId: ticket.id,
      cycleNo,
      isReopen,
      startedAt: c.startedAt,
      clockStartAt: c.clockStartAt,
      priority: c.priority,
      replyBudgetMinutes: c.replyBudgetMinutes,
      resolveBudgetMinutes: c.resolveBudgetMinutes,
      replyDueAt: c.replyDueAt,
      resolveDueAt: c.resolveDueAt,
    }).returning();
    await logEvent(tx, {
      ticketId: ticket.id, type: 'sla_cycle_started', actor: SYSTEM,
      payload: { cycle_no: cycleNo, reply_due_at: iso(c.replyDueAt), resolve_due_at: iso(c.resolveDueAt) },
    });
    return cycle;
  }

  // Breach flags are written once. The background job (step 04) catches breaches while a ticket sits;
  // these two checks make sure a late reply or late resolve is recorded even if the job has not run.
  async function flagReplyBreach(tx, cycle, at, detectedBy) {
    if (cycle.replyBreachedAt || !isOverdue(cycle.replyDueAt, at)) return;
    await tx.update(slaCycles).set({ replyBreachedAt: at })
      .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.replyBreachedAt)));
    await logEvent(tx, {
      ticketId: cycle.ticketId, type: 'reply_breached', actor: SYSTEM,
      payload: { due_at: iso(cycle.replyDueAt), detected_by: detectedBy },
    });
  }

  async function flagResolveBreach(tx, cycle, instant, at, detectedBy) {
    if (cycle.resolveBreachedAt || !isOverdue(cycle.resolveDueAt, instant)) return;
    await tx.update(slaCycles).set({ resolveBreachedAt: at })
      .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.resolveBreachedAt)));
    await logEvent(tx, {
      ticketId: cycle.ticketId, type: 'resolve_breached', actor: SYSTEM,
      payload: { due_at: iso(cycle.resolveDueAt), detected_by: detectedBy },
    });
  }

  async function upsertCustomer(tx, name, email) {
    const clean = email.trim();
    await tx.insert(customers).values({ name, email: clean }).onConflictDoNothing();
    const [customer] = await tx.select().from(customers)
      .where(sql`lower(${customers.email}) = ${clean.toLowerCase()}`);
    return customer;
  }

  // Shared by "customer raises a ticket" and "customer writes after the reopen window".
  async function openTicket(tx, engine, at, { customer, subject, body, priority, parentTicketId = null }) {
    const token = newToken();
    const [ticket] = await tx.insert(tickets).values({
      customerId: customer.id, subject, priority, parentTicketId,
      accessTokenHash: hashToken(token), createdAt: at, updatedAt: at,
    }).returning();
    const message = await insertMessage(tx, {
      ticketId: ticket.id, kind: 'public', actor: customerActor(customer.id), body, at,
    });
    await logEvent(tx, {
      ticketId: ticket.id, type: 'ticket_created', actor: customerActor(customer.id), messageId: message.id,
      payload: { priority, body_sha256: bodyHash(body), ...(parentTicketId ? { parent_ticket_id: parentTicketId } : {}) },
    });
    await startSlaCycle(tx, engine, ticket, 1, false, at);
    return { ticket, token, message };
  }

  return {
    // ---------------------------------------------------------------- customer side
    async createTicket({ name, email, subject, body, priority = 'medium' }) {
      return inTx(async (tx, engine, at) => {
        const customer = await upsertCustomer(tx, name, email);
        const { ticket, token } = await openTicket(tx, engine, at, { customer, subject, body, priority });
        return { ticket, token };
      });
    },

    // One entry point for everything a customer writes. Outcome depends on the ticket's state:
    //   new / open            -> 'replied'
    //   waiting_on_customer   -> 'replied' and the SLA clock resumes
    //   resolved, in window   -> 'reopened' (new SLA cycle)
    //   resolved past window, or closed -> 'new_ticket' linked to the old one
    async customerMessage(token, body) {
      return inTx(async (tx, engine, at) => {
        const [found] = await tx.select({ id: tickets.id }).from(tickets)
          .where(eq(tickets.accessTokenHash, hashToken(token)));
        if (!found) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
        const ticket = await lockTicket(tx, found.id);
        const actor = customerActor(ticket.customerId);

        if (ticket.status === 'closed' || (ticket.status === 'resolved' && ticket.reopenUntil < at)) {
          const [customer] = await tx.select().from(customers).where(eq(customers.id, ticket.customerId));
          const subject = (ticket.subject.startsWith('Re: ') ? ticket.subject : `Re: ${ticket.subject}`).slice(0, 200);
          const opened = await openTicket(tx, engine, at, {
            customer, subject, body, priority: ticket.priority, parentTicketId: ticket.id,
          });
          const reason = ticket.status === 'closed' ? 'ticket_closed' : 'reopen_window_elapsed';
          await logEvent(tx, {
            ticketId: ticket.id, type: 'linked_ticket_created', actor,
            payload: { child_ticket_id: opened.ticket.id, reason },
          });
          await logEvent(tx, {
            ticketId: opened.ticket.id, type: 'linked_ticket_created', actor,
            payload: { parent_ticket_id: ticket.id, reason },
          });
          return { outcome: 'new_ticket', ticket: opened.ticket, token: opened.token };
        }

        const message = await insertMessage(tx, {
          ticketId: ticket.id, kind: 'public', actor, body, recipientUserId: ticket.assigneeId, at,
        });
        const hash = bodyHash(body);

        if (ticket.status === 'resolved') {                       // inside the reopen window
          const [last] = await tx.select({ n: slaCycles.cycleNo }).from(slaCycles)
            .where(eq(slaCycles.ticketId, ticket.id)).orderBy(desc(slaCycles.cycleNo)).limit(1);
          const cycleNo = last.n + 1;
          const [updated] = await tx.update(tickets).set({
            status: 'open', resolvedAt: null, reopenUntil: null, reopenCount: sql`${tickets.reopenCount} + 1`,
          }).where(and(eq(tickets.id, ticket.id), eq(tickets.status, 'resolved'))).returning();
          await logEvent(tx, { ticketId: ticket.id, type: 'customer_replied', actor, messageId: message.id,
            payload: { body_sha256: hash } });
          await logEvent(tx, { ticketId: ticket.id, type: 'reopened', actor,
            payload: { reopen_count: updated.reopenCount, cycle_no: cycleNo } });
          await logEvent(tx, { ticketId: ticket.id, type: 'status_changed', actor,
            payload: { from: 'resolved', to: 'open' } });
          await startSlaCycle(tx, engine, updated, cycleNo, true, at);
          return { outcome: 'reopened', ticket: updated };
        }

        if (ticket.status === 'waiting_on_customer') {            // the customer answered: resume the clock
          const cycle = await activeCycle(tx, ticket.id);
          const pause = await openPause(tx, cycle.id);
          const minutes = pause ? pausedMinutes(engine, pause.pausedAt, at) : 0;
          if (pause) {
            await tx.update(slaPauses).set({ resumedAt: at, businessMinutes: minutes })
              .where(eq(slaPauses.id, pause.id));
          }
          const totalPaused = await closedPauseMinutes(tx, cycle.id);
          const due = dueDates(engine, {
            clockStartAt: cycle.clockStartAt,
            replyBudgetMinutes: cycle.replyBudgetMinutes,
            resolveBudgetMinutes: cycle.resolveBudgetMinutes,
            pausedBusinessMinutes: totalPaused,
          });
          await tx.update(slaCycles).set({ resolveDueAt: due.resolveDueAt }).where(eq(slaCycles.id, cycle.id));
          const [updated] = await tx.update(tickets)
            .set({ status: 'open', waitingSince: null, autoCloseAt: null })
            .where(eq(tickets.id, ticket.id)).returning();
          await logEvent(tx, { ticketId: ticket.id, type: 'customer_replied', actor, messageId: message.id,
            payload: { body_sha256: hash, resumed_sla: true } });
          await logEvent(tx, { ticketId: ticket.id, type: 'sla_resumed', actor,
            payload: { business_minutes: minutes, resolve_due_at: iso(due.resolveDueAt) } });
          await logEvent(tx, { ticketId: ticket.id, type: 'status_changed', actor,
            payload: { from: 'waiting_on_customer', to: 'open' } });
          return { outcome: 'replied', ticket: updated };
        }

        await logEvent(tx, { ticketId: ticket.id, type: 'customer_replied', actor, messageId: message.id,
          payload: { body_sha256: hash } });
        return { outcome: 'replied', ticket };
      });
    },

    // ---------------------------------------------------------------- agent side
    // Claim: the race from INC-0291. The row lock plus the guarded UPDATE means one winner, one 409.
    async claimTicket(ticketId, user) {
      return inTx(async (tx, _engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (ticket.assigneeId) {
          const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ticket.assigneeId));
          throw new HttpError(409, 'already_claimed', `Already claimed by ${owner?.name ?? 'another agent'}`);
        }
        if (!ACTIVE.includes(ticket.status)) {
          throw new HttpError(409, 'not_claimable', `A ${ticket.status} ticket cannot be claimed`);
        }
        const [updated] = await tx.update(tickets).set({
          assigneeId: user.id,
          claimedAt: at,
          status: sql`CASE WHEN ${tickets.status} = 'new' THEN 'open'::ticket_status ELSE ${tickets.status} END`,
        }).where(and(eq(tickets.id, ticketId), isNull(tickets.assigneeId), inArray(tickets.status, ACTIVE)))
          .returning();
        if (!updated) throw new HttpError(409, 'already_claimed', 'Already claimed by another agent');
        await logEvent(tx, { ticketId, type: 'claimed', actor: staffActor(user),
          payload: { status_after: updated.status } });
        return updated;
      });
    },

    // The owner, or a lead, can give a ticket back.
    async releaseTicket(ticketId, user) {
      return inTx(async (tx) => {
        const ticket = await lockTicket(tx, ticketId);
        if (!ticket.assigneeId) throw new HttpError(409, 'not_assigned', 'Ticket is not claimed');
        const byLead = user.role === 'lead' && ticket.assigneeId !== user.id;
        if (ticket.assigneeId !== user.id && user.role !== 'lead') {
          throw new HttpError(403, 'forbidden', 'Only the owner or a lead can release this ticket');
        }
        const [updated] = await tx.update(tickets).set({ assigneeId: null, claimedAt: null })
          .where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'released', actor: staffActor(user),
          payload: { from_user_id: ticket.assigneeId, by_lead: byLead } });
        return updated;
      });
    },

    async reassignTicket(ticketId, user, toUserId) {
      if (user.role !== 'lead') throw new HttpError(403, 'forbidden', 'Only a lead can reassign tickets');
      return inTx(async (tx, _engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (!ACTIVE.includes(ticket.status)) {
          throw new HttpError(409, 'not_claimable', `A ${ticket.status} ticket cannot be reassigned`);
        }
        const [target] = await tx.select().from(users).where(eq(users.id, toUserId));
        if (!target || !target.active) throw new HttpError(400, 'validation_error', 'Target agent not found or inactive');
        const [updated] = await tx.update(tickets).set({
          assigneeId: target.id,
          claimedAt: at,
          status: sql`CASE WHEN ${tickets.status} = 'new' THEN 'open'::ticket_status ELSE ${tickets.status} END`,
        }).where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'reassigned', actor: staffActor(user),
          payload: { from_user_id: ticket.assigneeId, to_user_id: target.id } });
        return updated;
      });
    },

    // Private team note (INC-0304). Any staff member can write one. It never touches the SLA.
    async addNote(ticketId, user, body) {
      return inTx(async (tx, _engine, at) => {
        await lockTicket(tx, ticketId);
        const message = await insertMessage(tx, {
          ticketId, kind: 'note', actor: staffActor(user), body, at,
        });
        await logEvent(tx, { ticketId, type: 'note_added', actor: staffActor(user), messageId: message.id,
          payload: { body_sha256: bodyHash(body) } });
        return message;
      });
    },

    // Public reply. Only the owner can send it. Only a public reply counts as the first response.
    async replyPublic(ticketId, user, { body, setWaiting = false }) {
      return inTx(async (tx, engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (ticket.assigneeId !== user.id) {
          throw ticket.assigneeId
            ? new HttpError(403, 'not_owner', 'Only the agent who owns this ticket can reply')
            : new HttpError(409, 'claim_required', 'Claim this ticket before replying');
        }
        if (ticket.status !== 'open' && ticket.status !== 'waiting_on_customer') {
          throw new HttpError(409, 'ticket_closed', `A ${ticket.status} ticket cannot be replied to`);
        }
        const actor = staffActor(user);
        const message = await insertMessage(tx, { ticketId, kind: 'public', actor, body, at });
        const cycle = await activeCycle(tx, ticketId);
        const isFirst = !cycle.firstResponseAt;
        await logEvent(tx, { ticketId, type: 'public_reply_sent', actor, messageId: message.id,
          payload: { body_sha256: bodyHash(body), first_response: isFirst } });

        if (isFirst) {
          await tx.update(slaCycles).set({ firstResponseAt: at, firstResponseMessageId: message.id })
            .where(eq(slaCycles.id, cycle.id));
          await flagReplyBreach(tx, cycle, at, 'reply');
        }

        let current = ticket;
        if (setWaiting && ticket.status === 'open') {
          [current] = await tx.update(tickets).set({
            status: 'waiting_on_customer', waitingSince: at, autoCloseAt: autoCloseAt(engine, at),
          }).where(eq(tickets.id, ticketId)).returning();
          await tx.insert(slaPauses).values({ cycleId: cycle.id, ticketId, pausedAt: at });
          await logEvent(tx, { ticketId, type: 'status_changed', actor,
            payload: { from: 'open', to: 'waiting_on_customer' } });
          await logEvent(tx, { ticketId, type: 'sla_paused', actor,
            payload: { auto_close_at: iso(current.autoCloseAt) } });
        }
        return { message, ticket: current };
      });
    },

    // Priority change (Meera's unanswered question). Same clock start, new budgets, recorded breaches stay.
    async setPriority(ticketId, user, newPriority) {
      return inTx(async (tx, engine) => {
        const ticket = await lockTicket(tx, ticketId);
        if (user.role !== 'lead' && ticket.assigneeId !== user.id) {
          throw new HttpError(403, 'forbidden', 'Only the owner or a lead can change the priority');
        }
        if (!ACTIVE.includes(ticket.status)) {
          throw new HttpError(409, 'ticket_closed', `A ${ticket.status} ticket cannot change priority`);
        }
        if (ticket.priority === newPriority) return ticket;
        const cycle = await activeCycle(tx, ticketId);
        const paused = await closedPauseMinutes(tx, cycle.id);
        const next = recomputeForPriority(engine, cycle, newPriority, paused);
        await tx.update(slaCycles).set({
          priority: next.priority,
          replyBudgetMinutes: next.replyBudgetMinutes,
          resolveBudgetMinutes: next.resolveBudgetMinutes,
          replyDueAt: next.replyDueAt,
          resolveDueAt: next.resolveDueAt,
        }).where(eq(slaCycles.id, cycle.id));
        const [updated] = await tx.update(tickets).set({ priority: newPriority })
          .where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'priority_changed', actor: staffActor(user), payload: {
          from: ticket.priority, to: newPriority,
          old_reply_due_at: iso(cycle.replyDueAt), new_reply_due_at: iso(next.replyDueAt),
          old_resolve_due_at: iso(cycle.resolveDueAt), new_resolve_due_at: iso(next.resolveDueAt),
        } });
        return updated;
      });
    },

    // Resolve: the owner marks it done. Starts the reopen window and ends the SLA cycle.
    async resolveTicket(ticketId, user) {
      return inTx(async (tx, engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (ticket.assigneeId !== user.id) {
          throw new HttpError(403, 'not_owner', 'Only the agent who owns this ticket can resolve it');
        }
        if (ticket.status !== 'open' && ticket.status !== 'waiting_on_customer') {
          throw new HttpError(409, 'ticket_closed', `A ${ticket.status} ticket cannot be resolved`);
        }
        const actor = staffActor(user);
        const cycle = await activeCycle(tx, ticketId);
        const pause = await openPause(tx, cycle.id);
        let judgedAt = at;                                   // time that counts against the SLA
        if (pause) {
          const minutes = pausedMinutes(engine, pause.pausedAt, at);
          await tx.update(slaPauses).set({ resumedAt: at, businessMinutes: minutes })
            .where(eq(slaPauses.id, pause.id));
          await logEvent(tx, { ticketId, type: 'sla_resumed', actor,
            payload: { business_minutes: minutes, reason: 'resolved' } });
          judgedAt = pause.pausedAt;                         // waiting time is not Arvo's fault
        }
        if (!cycle.firstResponseAt) await flagReplyBreach(tx, cycle, at, 'resolve');
        await flagResolveBreach(tx, cycle, judgedAt, at, 'resolve');
        await tx.update(slaCycles).set({ resolvedAt: at, endedAt: at }).where(eq(slaCycles.id, cycle.id));
        const until = reopenUntil(engine, at);
        const [updated] = await tx.update(tickets).set({
          status: 'resolved', resolvedAt: at, reopenUntil: until, waitingSince: null, autoCloseAt: null,
        }).where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'resolved', actor, payload: { reopen_until: iso(until) } });
        await logEvent(tx, { ticketId, type: 'status_changed', actor,
          payload: { from: ticket.status, to: 'resolved' } });
        return updated;
      });
    },
  };
}
