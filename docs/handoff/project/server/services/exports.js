import { and, asc, eq } from 'drizzle-orm';
import {
  customerMessages,
  customerTickets,
  customers,
  messages,
  tickets,
  users,
} from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo, iso } from '../lib/format.js';
import { hashToken } from '../lib/tokens.js';
import { customerActor, logEvent, staffActor } from './events.js';

const CSV_FORMATS = new Set(['csv', 'json']);

function assertFormat(format) {
  if (!CSV_FORMATS.has(format)) {
    throw new HttpError(400, 'validation_error', 'format must be one of: csv, json');
  }
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvDocument(headers, rows) {
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\r\n');
}

function result(ticketNo, format, data, headers, rows) {
  const body = format === 'json' ? JSON.stringify(data) : csvDocument(headers, rows);
  return {
    body,
    contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    filename: `ticket-${ticketNo}.${format}`,
  };
}

function authorName(message) {
  if (message.authorType === 'staff') return message.staffName;
  if (message.authorType === 'customer') return message.customerName;
  return 'Frontdesk';
}

function ticketMessage(message) {
  return {
    id: message.id,
    kind: message.kind,
    authorType: message.authorType,
    authorName: authorName(message),
    body: message.body,
    createdAt: iso(message.createdAt),
  };
}

async function loadAgentExport(tx, id, includeNotes) {
  const [ticket] = await tx.select().from(tickets)
    .where(eq(tickets.id, id))
    .for('update');
  if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
  const [[customer], [assignee]] = await Promise.all([
    tx.select({ name: customers.name, email: customers.email })
      .from(customers)
      .where(eq(customers.id, ticket.customerId)),
    ticket.assigneeId === null
      ? Promise.resolve([])
      : tx.select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, ticket.assigneeId)),
  ]);
  if (!customer) throw new Error(`Ticket ${id} has no customer`);

  const thread = await tx.select({
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

  const visibleThread = thread
    .filter((message) => includeNotes || message.kind === 'public')
    .map(ticketMessage);
  const ticketNo = formatTicketNo(ticket.ticketNo);
  const data = {
    ticket: {
      id: ticket.id,
      ticketNo,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      customer: { name: customer.name, email: customer.email },
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
      createdAt: iso(ticket.createdAt),
      updatedAt: iso(ticket.updatedAt),
      waitingSince: iso(ticket.waitingSince),
      autoCloseAt: iso(ticket.autoCloseAt),
      resolvedAt: iso(ticket.resolvedAt),
      reopenUntil: iso(ticket.reopenUntil),
      closedAt: iso(ticket.closedAt),
      closedReason: ticket.closedReason,
    },
    messages: visibleThread,
  };
  const headers = [
    'ticketNo',
    'subject',
    'priority',
    'status',
    'customerName',
    'customerEmail',
    'assigneeName',
    'ticketCreatedAt',
    'messageId',
    'kind',
    'authorType',
    'authorName',
    'messageBody',
    'messageCreatedAt',
  ];
  const rows = visibleThread.length
    ? visibleThread.map((message) => ({
      ticketNo,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      customerName: customer.name,
      customerEmail: customer.email,
      assigneeName: assignee?.name,
      ticketCreatedAt: data.ticket.createdAt,
      messageId: message.id,
      kind: message.kind,
      authorType: message.authorType,
      authorName: message.authorName,
      messageBody: message.body,
      messageCreatedAt: message.createdAt,
    }))
    : [{
      ticketNo,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      customerName: customer.name,
      customerEmail: customer.email,
      assigneeName: assignee?.name,
      ticketCreatedAt: data.ticket.createdAt,
    }];

  return { ticket, data, headers, rows };
}

export function createExportService({ db, customerDb = db }) {
  return {
    async agentTicket(id, user, format, includeNotes = false) {
      assertFormat(format);
      return db.transaction(async (tx) => {
        const exported = await loadAgentExport(tx, id, includeNotes);
        await logEvent(tx, {
          ticketId: id,
          type: 'export_generated',
          actor: staffActor(user),
          payload: { format, include_notes: includeNotes },
        });
        return result(
          formatTicketNo(exported.ticket.ticketNo),
          format,
          exported.data,
          exported.headers,
          exported.rows,
        );
      });
    },

    async customerTicket(token, format) {
      assertFormat(format);
      const accessTokenHash = hashToken(token);
      const [ticket] = await customerDb.select({
        id: customerTickets.id,
        ticketNo: customerTickets.ticketNo,
        subject: customerTickets.subject,
        status: customerTickets.status,
        createdAt: customerTickets.createdAt,
        resolvedAt: customerTickets.resolvedAt,
        reopenUntil: customerTickets.reopenUntil,
        closedAt: customerTickets.closedAt,
      })
        .from(customerTickets)
        .where(eq(customerTickets.accessTokenHash, accessTokenHash));
      if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');

      const thread = await customerDb.select({
        authorType: customerMessages.authorType,
        authorName: customerMessages.authorName,
        body: customerMessages.body,
        createdAt: customerMessages.createdAt,
      })
        .from(customerMessages)
        .where(eq(customerMessages.accessTokenHash, accessTokenHash))
        .orderBy(asc(customerMessages.createdAt), asc(customerMessages.id));
      const ticketNo = formatTicketNo(ticket.ticketNo);
      const data = {
        ticketNo,
        subject: ticket.subject,
        status: ticket.status,
        createdAt: iso(ticket.createdAt),
        resolvedAt: iso(ticket.resolvedAt),
        reopenUntil: iso(ticket.reopenUntil),
        closedAt: iso(ticket.closedAt),
        messages: thread.map((message) => ({
          authorType: message.authorType,
          authorName: message.authorName,
          body: message.body,
          createdAt: iso(message.createdAt),
        })),
      };
      const headers = [
        'ticketNo',
        'subject',
        'status',
        'ticketCreatedAt',
        'resolvedAt',
        'reopenUntil',
        'closedAt',
        'authorType',
        'authorName',
        'messageBody',
        'messageCreatedAt',
      ];
      const rows = data.messages.length
        ? data.messages.map((message) => ({
          ticketNo,
          subject: ticket.subject,
          status: ticket.status,
          ticketCreatedAt: data.createdAt,
          resolvedAt: data.resolvedAt,
          reopenUntil: data.reopenUntil,
          closedAt: data.closedAt,
          authorType: message.authorType,
          authorName: message.authorName,
          messageBody: message.body,
          messageCreatedAt: message.createdAt,
        }))
        : [{
          ticketNo,
          subject: ticket.subject,
          status: ticket.status,
          ticketCreatedAt: data.createdAt,
          resolvedAt: data.resolvedAt,
          reopenUntil: data.reopenUntil,
          closedAt: data.closedAt,
        }];

      const [auditTicket] = await db.select({ customerId: tickets.customerId })
        .from(tickets)
        .where(and(eq(tickets.id, ticket.id), eq(tickets.accessTokenHash, accessTokenHash)));
      if (!auditTicket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      await db.transaction(async (tx) => logEvent(tx, {
        ticketId: ticket.id,
        type: 'export_generated',
        actor: customerActor(auditTicket.customerId),
        payload: { format, include_notes: false },
      }));

      return result(ticketNo, format, data, headers, rows);
    },
  };
}
