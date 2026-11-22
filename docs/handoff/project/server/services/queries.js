import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  agentTicketList, customerMessages, customerTickets, customers, messages,
  slaCycles, slaPauses, ticketEvents, tickets, users,
} from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo, iso } from '../lib/format.js';
import { hashToken } from '../lib/tokens.js';
import { dbClock } from './tickets.js';

const ACTIVE = ['new', 'open', 'waiting_on_customer'];
export const LIST_VIEWS = ['open', 'mine', 'unclaimed', 'waiting', 'late', 'resolved', 'all'];

// Read side. Agent reads use `db`. Customer reads use `customerDb`, which in production can be a
// connection that is ONLY allowed to read the two customer_* views (see db/migrations/0002).
export function createQueries({ db, customerDb = db, clock = dbClock }) {
  return {
    // ----- agent: ticket list. Metadata only. NO message text is selected anywhere in this query. -----
    async listTickets(user, view) {
      const v = agentTicketList;
      const filters = {
        open: inArray(v.status, ACTIVE),
        mine: and(eq(v.assigneeId, user.id), inArray(v.status, ACTIVE)),
        unclaimed: eq(v.isUnclaimed, true),
        waiting: eq(v.isWaiting, true),
        late: and(inArray(v.status, ACTIVE), or(eq(v.replyLate, true), eq(v.resolveLate, true))),
        resolved: eq(v.status, 'resolved'),
        all: undefined,
      };
      const rows = await db
        .select({
          id: v.id, ticketNo: v.ticketNo, subject: v.subject, priority: v.priority, status: v.status,
          assigneeId: v.assigneeId, assigneeName: users.name, customerName: customers.name,
          isWaiting: v.isWaiting, isUnclaimed: v.isUnclaimed, replyLate: v.replyLate, resolveLate: v.resolveLate,
          nextDueAt: v.nextDueAt, replyDueAt: v.replyDueAt, resolveDueAt: v.resolveDueAt,
          waitingSince: v.waitingSince, autoCloseAt: v.autoCloseAt, reopenUntil: v.reopenUntil,
          createdAt: v.createdAt, updatedAt: v.updatedAt,
        })
        .from(v)
        .innerJoin(customers, eq(customers.id, v.customerId))
        .leftJoin(users, eq(users.id, v.assigneeId))
        .where(filters[view])
        .orderBy(sql`(${v.replyLate} OR ${v.resolveLate}) DESC`, sql`${v.nextDueAt} ASC NULLS LAST`, asc(v.id));

      return rows.map((r) => ({
        id: r.id,
        ticketNo: formatTicketNo(r.ticketNo),
        subject: r.subject,
        priority: r.priority,
        status: r.status,
        customerName: r.customerName,
        assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName } : null,
        isMine: r.assigneeId === user.id,
        isUnclaimed: r.isUnclaimed,
        isWaiting: r.isWaiting,
        isLate: r.replyLate || r.resolveLate,
        replyLate: r.replyLate,
        resolveLate: r.resolveLate,
        nextDueAt: iso(r.nextDueAt),
        replyDueAt: iso(r.replyDueAt),
        resolveDueAt: iso(r.resolveDueAt),
        waitingSince: iso(r.waitingSince),
        autoCloseAt: iso(r.autoCloseAt),
        reopenUntil: iso(r.reopenUntil),
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      }));
    },

    // ----- agent: one ticket with the FULL thread (notes included), the audit timeline and SLA state -----
    async getAgentTicket(id) {
      const [row] = await db
        .select({ ticket: tickets, customerName: customers.name, customerEmail: customers.email, assigneeName: users.name })
        .from(tickets)
        .innerJoin(customers, eq(customers.id, tickets.customerId))
        .leftJoin(users, eq(users.id, tickets.assigneeId))
        .where(eq(tickets.id, id));
      if (!row) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      const t = row.ticket;

      const authorUser = users;
      const thread = await db
        .select({
          id: messages.id, kind: messages.kind, authorType: messages.authorType, body: messages.body,
          createdAt: messages.createdAt, recipientUserId: messages.recipientUserId,
          staffName: authorUser.name, customerName: customers.name,
        })
        .from(messages)
        .leftJoin(authorUser, eq(authorUser.id, messages.authorUserId))
        .leftJoin(customers, eq(customers.id, messages.authorCustomerId))
        .where(eq(messages.ticketId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id));

      const timeline = await db
        .select({
          chainSeq: ticketEvents.chainSeq, type: ticketEvents.type, actorType: ticketEvents.actorType,
          messageId: ticketEvents.messageId, payload: ticketEvents.payload, createdAt: ticketEvents.createdAt,
          staffName: users.name, customerName: customers.name,
        })
        .from(ticketEvents)
        .leftJoin(users, eq(users.id, ticketEvents.actorUserId))
        .leftJoin(customers, eq(customers.id, ticketEvents.actorCustomerId))
        .where(eq(ticketEvents.ticketId, id))
        .orderBy(asc(ticketEvents.chainSeq));

      const cycles = await db.select().from(slaCycles).where(eq(slaCycles.ticketId, id)).orderBy(asc(slaCycles.cycleNo));
      const pauses = await db.select().from(slaPauses).where(eq(slaPauses.ticketId, id)).orderBy(asc(slaPauses.id));
      const [flags] = await db.select({ replyLate: agentTicketList.replyLate, resolveLate: agentTicketList.resolveLate })
        .from(agentTicketList).where(eq(agentTicketList.id, id));

      return {
        ticket: {
          id: t.id, ticketNo: formatTicketNo(t.ticketNo), subject: t.subject, priority: t.priority, status: t.status,
          customer: { id: t.customerId, name: row.customerName, email: row.customerEmail },
          assignee: t.assigneeId ? { id: t.assigneeId, name: row.assigneeName } : null,
          parentTicketId: t.parentTicketId, reopenCount: t.reopenCount,
          waitingSince: iso(t.waitingSince), autoCloseAt: iso(t.autoCloseAt),
          resolvedAt: iso(t.resolvedAt), reopenUntil: iso(t.reopenUntil), closedAt: iso(t.closedAt),
          closedReason: t.closedReason, createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt),
          isLate: Boolean(flags?.replyLate || flags?.resolveLate),
        },
        messages: thread.map((m) => ({
          id: m.id, kind: m.kind, authorType: m.authorType,
          authorName: m.authorType === 'staff' ? m.staffName : m.authorType === 'customer' ? m.customerName : 'Frontdesk',
          body: m.body, createdAt: iso(m.createdAt),
        })),
        events: timeline.map((e) => ({
          seq: e.chainSeq, type: e.type, actorType: e.actorType,
          actorName: e.actorType === 'staff' ? e.staffName : e.actorType === 'customer' ? e.customerName : 'System',
          messageId: e.messageId, payload: e.payload, createdAt: iso(e.createdAt),
        })),
        sla: {
          cycles: cycles.map((c) => ({
            cycleNo: c.cycleNo, isReopen: c.isReopen, priority: c.priority,
            startedAt: iso(c.startedAt), clockStartAt: iso(c.clockStartAt),
            replyDueAt: iso(c.replyDueAt), resolveDueAt: iso(c.resolveDueAt),
            firstResponseAt: iso(c.firstResponseAt), resolvedAt: iso(c.resolvedAt),
            replyBreachedAt: iso(c.replyBreachedAt), resolveBreachedAt: iso(c.resolveBreachedAt),
          })),
          pauses: pauses.map((p) => ({
            pausedAt: iso(p.pausedAt), resumedAt: iso(p.resumedAt), businessMinutes: p.businessMinutes,
          })),
        },
      };
    },

    async listUsers() {
      const rows = await db.select({ id: users.id, name: users.name, role: users.role, active: users.active })
        .from(users).orderBy(asc(users.name));
      return rows;
    },

    // ----- customer: ONLY the customer_* views, and every field is whitelisted by hand -----
    async getCustomerTicket(token) {
      const hash = hashToken(token);
      const [t] = await customerDb.select().from(customerTickets).where(eq(customerTickets.accessTokenHash, hash));
      if (!t) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      const thread = await customerDb
        .select({
          id: customerMessages.id, authorType: customerMessages.authorType, authorName: customerMessages.authorName,
          body: customerMessages.body, createdAt: customerMessages.createdAt,
        })
        .from(customerMessages)
        .where(eq(customerMessages.accessTokenHash, hash))
        .orderBy(asc(customerMessages.createdAt), asc(customerMessages.id));
      const now = await clock(customerDb);
      return {
        ticketNo: formatTicketNo(t.ticketNo),
        subject: t.subject,
        status: t.status,
        createdAt: iso(t.createdAt),
        resolvedAt: iso(t.resolvedAt),
        reopenUntil: iso(t.reopenUntil),
        closedAt: iso(t.closedAt),
        canReopen: t.status === 'resolved' && t.reopenUntil != null && t.reopenUntil >= now,
        messages: thread.map((m) => ({
          id: m.id, authorType: m.authorType, authorName: m.authorName, body: m.body, createdAt: iso(m.createdAt),
        })),
      };
    },
  };
}
