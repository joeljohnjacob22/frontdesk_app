import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  agentTicketList,
  customerMessages,
  customerTickets,
  customers,
  messages,
  slaCycles,
  slaPauses,
  ticketEvents,
  tickets,
  users,
} from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo, iso } from '../lib/format.js';
import { hashToken } from '../lib/tokens.js';
import { dbClock } from './tickets.js';

const ACTIVE_STATUSES = ['new', 'open', 'waiting_on_customer'];
export const LIST_VIEWS = ['open', 'mine', 'unclaimed', 'waiting', 'late', 'resolved', 'all'];

export function createQueries({ db, customerDb = db, clock = dbClock }) {
  return {
    async listTickets(user, view) {
      const list = agentTicketList;
      const filters = {
        open: inArray(list.status, ACTIVE_STATUSES),
        mine: and(eq(list.assigneeId, user.id), inArray(list.status, ACTIVE_STATUSES)),
        unclaimed: eq(list.isUnclaimed, true),
        waiting: eq(list.isWaiting, true),
        late: and(
          inArray(list.status, ACTIVE_STATUSES),
          or(eq(list.replyLate, true), eq(list.resolveLate, true)),
        ),
        resolved: eq(list.status, 'resolved'),
        all: undefined,
      };
      const rows = await db.select({
        id: list.id,
        ticketNo: list.ticketNo,
        subject: list.subject,
        priority: list.priority,
        status: list.status,
        assigneeId: list.assigneeId,
        assigneeName: users.name,
        customerName: customers.name,
        isWaiting: list.isWaiting,
        isUnclaimed: list.isUnclaimed,
        replyLate: list.replyLate,
        resolveLate: list.resolveLate,
        nextDueAt: list.nextDueAt,
        replyDueAt: list.replyDueAt,
        resolveDueAt: list.resolveDueAt,
        waitingSince: list.waitingSince,
        autoCloseAt: list.autoCloseAt,
        reopenUntil: list.reopenUntil,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
      })
        .from(list)
        .innerJoin(customers, eq(customers.id, list.customerId))
        .leftJoin(users, eq(users.id, list.assigneeId))
        .where(filters[view])
        .orderBy(
          sql`(${list.replyLate} OR ${list.resolveLate}) DESC`,
          sql`${list.nextDueAt} ASC NULLS LAST`,
          asc(list.id),
        );

      return rows.map((row) => ({
        id: row.id,
        ticketNo: formatTicketNo(row.ticketNo),
        subject: row.subject,
        priority: row.priority,
        status: row.status,
        customerName: row.customerName,
        assignee: row.assigneeId === null ? null : { id: row.assigneeId, name: row.assigneeName },
        isMine: row.assigneeId === user.id,
        isUnclaimed: row.isUnclaimed,
        isWaiting: row.isWaiting,
        isLate: row.replyLate || row.resolveLate,
        replyLate: row.replyLate,
        resolveLate: row.resolveLate,
        nextDueAt: iso(row.nextDueAt),
        replyDueAt: iso(row.replyDueAt),
        resolveDueAt: iso(row.resolveDueAt),
        waitingSince: iso(row.waitingSince),
        autoCloseAt: iso(row.autoCloseAt),
        reopenUntil: iso(row.reopenUntil),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }));
    },

    async getAgentTicket(id) {
      const [row] = await db.select({
        ticket: tickets,
        customerName: customers.name,
        customerEmail: customers.email,
        assigneeName: users.name,
      })
        .from(tickets)
        .innerJoin(customers, eq(customers.id, tickets.customerId))
        .leftJoin(users, eq(users.id, tickets.assigneeId))
        .where(eq(tickets.id, id));
      if (!row) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      const ticket = row.ticket;

      const thread = await db.select({
        id: messages.id,
        kind: messages.kind,
        authorType: messages.authorType,
        body: messages.body,
        createdAt: messages.createdAt,
        staffName: users.name,
        customerName: customers.name,
      })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorUserId))
        .leftJoin(customers, eq(customers.id, messages.authorCustomerId))
        .where(eq(messages.ticketId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id));

      const timeline = await db.select({
        chainSeq: ticketEvents.chainSeq,
        type: ticketEvents.type,
        actorType: ticketEvents.actorType,
        messageId: ticketEvents.messageId,
        payload: ticketEvents.payload,
        createdAt: ticketEvents.createdAt,
        staffName: users.name,
        customerName: customers.name,
      })
        .from(ticketEvents)
        .leftJoin(users, eq(users.id, ticketEvents.actorUserId))
        .leftJoin(customers, eq(customers.id, ticketEvents.actorCustomerId))
        .where(eq(ticketEvents.ticketId, id))
        .orderBy(asc(ticketEvents.chainSeq));

      const cycles = await db.select().from(slaCycles)
        .where(eq(slaCycles.ticketId, id))
        .orderBy(asc(slaCycles.cycleNo));
      const pauses = await db.select().from(slaPauses)
        .where(eq(slaPauses.ticketId, id))
        .orderBy(asc(slaPauses.id));
      const [flags] = await db.select({
        replyLate: agentTicketList.replyLate,
        resolveLate: agentTicketList.resolveLate,
      })
        .from(agentTicketList)
        .where(eq(agentTicketList.id, id));

      return {
        ticket: {
          id: ticket.id,
          ticketNo: formatTicketNo(ticket.ticketNo),
          subject: ticket.subject,
          priority: ticket.priority,
          status: ticket.status,
          customer: { id: ticket.customerId, name: row.customerName, email: row.customerEmail },
          assignee: ticket.assigneeId === null
            ? null
            : { id: ticket.assigneeId, name: row.assigneeName },
          parentTicketId: ticket.parentTicketId,
          reopenCount: ticket.reopenCount,
          waitingSince: iso(ticket.waitingSince),
          autoCloseAt: iso(ticket.autoCloseAt),
          resolvedAt: iso(ticket.resolvedAt),
          reopenUntil: iso(ticket.reopenUntil),
          closedAt: iso(ticket.closedAt),
          closedReason: ticket.closedReason,
          createdAt: iso(ticket.createdAt),
          updatedAt: iso(ticket.updatedAt),
          isLate: Boolean(flags?.replyLate || flags?.resolveLate),
        },
        messages: thread.map((message) => ({
          id: message.id,
          kind: message.kind,
          authorType: message.authorType,
          authorName: message.authorType === 'staff'
            ? message.staffName
            : message.authorType === 'customer' ? message.customerName : 'Frontdesk',
          body: message.body,
          createdAt: iso(message.createdAt),
        })),
        events: timeline.map((event) => ({
          seq: event.chainSeq,
          type: event.type,
          actorType: event.actorType,
          actorName: event.actorType === 'staff'
            ? event.staffName
            : event.actorType === 'customer' ? event.customerName : 'System',
          messageId: event.messageId,
          payload: event.payload,
          createdAt: iso(event.createdAt),
        })),
        sla: {
          cycles: cycles.map((cycle) => ({
            cycleNo: cycle.cycleNo,
            isReopen: cycle.isReopen,
            priority: cycle.priority,
            startedAt: iso(cycle.startedAt),
            clockStartAt: iso(cycle.clockStartAt),
            replyDueAt: iso(cycle.replyDueAt),
            resolveDueAt: iso(cycle.resolveDueAt),
            firstResponseAt: iso(cycle.firstResponseAt),
            resolvedAt: iso(cycle.resolvedAt),
            replyBreachedAt: iso(cycle.replyBreachedAt),
            resolveBreachedAt: iso(cycle.resolveBreachedAt),
          })),
          pauses: pauses.map((pause) => ({
            pausedAt: iso(pause.pausedAt),
            resumedAt: iso(pause.resumedAt),
            businessMinutes: pause.businessMinutes,
          })),
        },
      };
    },

    async listUsers() {
      return db.select({
        id: users.id,
        name: users.name,
        role: users.role,
        active: users.active,
      })
        .from(users)
        .orderBy(asc(users.name));
    },

    async getCustomerTicket(token) {
      const hash = hashToken(token);
      const [ticket] = await customerDb.select({
        ticketNo: customerTickets.ticketNo,
        subject: customerTickets.subject,
        status: customerTickets.status,
        createdAt: customerTickets.createdAt,
        resolvedAt: customerTickets.resolvedAt,
        reopenUntil: customerTickets.reopenUntil,
        closedAt: customerTickets.closedAt,
      })
        .from(customerTickets)
        .where(eq(customerTickets.accessTokenHash, hash));
      if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');

      const thread = await customerDb.select({
        id: customerMessages.id,
        authorType: customerMessages.authorType,
        authorName: customerMessages.authorName,
        body: customerMessages.body,
        createdAt: customerMessages.createdAt,
      })
        .from(customerMessages)
        .where(eq(customerMessages.accessTokenHash, hash))
        .orderBy(asc(customerMessages.createdAt), asc(customerMessages.id));
      const now = await clock(customerDb);

      return {
        ticketNo: formatTicketNo(ticket.ticketNo),
        subject: ticket.subject,
        status: ticket.status,
        createdAt: iso(ticket.createdAt),
        resolvedAt: iso(ticket.resolvedAt),
        reopenUntil: iso(ticket.reopenUntil),
        closedAt: iso(ticket.closedAt),
        canReopen: ticket.status === 'resolved'
          && ticket.reopenUntil !== null
          && ticket.reopenUntil >= now,
        messages: thread.map((message) => ({
          id: message.id,
          authorType: message.authorType,
          authorName: message.authorName,
          body: message.body,
          createdAt: iso(message.createdAt),
        })),
      };
    },
  };
}
