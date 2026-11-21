import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, pgView, bigint, integer, text, boolean, timestamp, jsonb,
  customType, index, uniqueIndex, unique, check, date,
} from 'drizzle-orm/pg-core';

// ---------- helpers ----------
const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const fk = (name) => bigint(name, { mode: 'number' });
const tstz = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType({ dataType: () => 'bytea' });

// ---------- enums ----------
export const userRole = pgEnum('user_role', ['agent', 'lead']);
export const ticketPriority = pgEnum('ticket_priority', ['high', 'medium', 'low']);
export const ticketStatus = pgEnum('ticket_status', ['new', 'open', 'waiting_on_customer', 'resolved', 'closed']);
export const messageKind = pgEnum('message_kind', ['public', 'note']);
export const actorType = pgEnum('actor_type', ['staff', 'customer', 'system']);
export const closedReason = pgEnum('closed_reason', ['customer_no_reply', 'resolution_window_elapsed']);

// ---------- reference / config ----------
export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('agent'),
  active: boolean('active').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
  check('users_name_chk', sql`length(btrim(${t.name})) > 0`),
]);

export const customers = pgTable('customers', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('customers_email_uq').on(sql`lower(${t.email})`),
  check('customers_name_chk', sql`length(btrim(${t.name})) > 0`),
]);

export const holidays = pgTable('holidays', {
  holidayDate: date('holiday_date', { mode: 'string' }).primaryKey(),
  name: text('name').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  description: text('description'),
});

export const slaPolicies = pgTable('sla_policies', {
  priority: ticketPriority('priority').primaryKey(),
  replyMinutes: integer('reply_minutes').notNull(),
  resolveMinutes: integer('resolve_minutes'),
  resolveSameDay: boolean('resolve_same_day').notNull().default(false),
}, (t) => [
  check('sla_policies_reply_chk', sql`${t.replyMinutes} > 0`),
  check('sla_policies_resolve_chk', sql`(${t.resolveSameDay} AND ${t.resolveMinutes} IS NULL) OR (NOT ${t.resolveSameDay} AND ${t.resolveMinutes} > 0)`),
]);

// ---------- tickets ----------
export const tickets = pgTable('tickets', {
  id: id(),
  ticketNo: integer('ticket_no').notNull().unique().generatedAlwaysAsIdentity(),
  customerId: fk('customer_id').notNull().references(() => customers.id),
  subject: text('subject').notNull(),
  priority: ticketPriority('priority').notNull().default('medium'),
  status: ticketStatus('status').notNull().default('new'),
  assigneeId: fk('assignee_id').references(() => users.id),
  claimedAt: tstz('claimed_at'),
  parentTicketId: fk('parent_ticket_id').references(() => tickets.id),
  accessTokenHash: bytea('access_token_hash').notNull().unique(),
  waitingSince: tstz('waiting_since'),
  autoCloseAt: tstz('auto_close_at'),
  resolvedAt: tstz('resolved_at'),
  reopenUntil: tstz('reopen_until'),
  closedAt: tstz('closed_at'),
  closedReason: closedReason('closed_reason'),
  reopenCount: integer('reopen_count').notNull().default(0),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => [
  check('tickets_subject_chk', sql`length(btrim(${t.subject})) > 0 AND length(${t.subject}) <= 200`),
  check('tickets_no_self_parent', sql`${t.parentTicketId} IS NULL OR ${t.parentTicketId} <> ${t.id}`),
  check('tickets_new_unassigned', sql`${t.status} <> 'new' OR ${t.assigneeId} IS NULL`),
  check('tickets_waiting_fields', sql`(${t.status} = 'waiting_on_customer') = (${t.waitingSince} IS NOT NULL AND ${t.autoCloseAt} IS NOT NULL)`),
  check('tickets_resolved_fields', sql`${t.status} <> 'resolved' OR (${t.resolvedAt} IS NOT NULL AND ${t.reopenUntil} IS NOT NULL)`),
  check('tickets_closed_fields', sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL AND ${t.closedReason} IS NOT NULL)`),
  check('tickets_reopen_count_chk', sql`${t.reopenCount} >= 0`),
  index('tickets_assignee_status_idx').on(t.assigneeId, t.status),
  index('tickets_status_idx').on(t.status),
  index('tickets_customer_idx').on(t.customerId),
  index('tickets_parent_idx').on(t.parentTicketId).where(sql`${t.parentTicketId} IS NOT NULL`),
  index('tickets_auto_close_idx').on(t.autoCloseAt).where(sql`${t.status} = 'waiting_on_customer'`),
  index('tickets_reopen_until_idx').on(t.reopenUntil).where(sql`${t.status} = 'resolved'`),
]);

// ---------- messages (append-only: triggers live in the custom migration) ----------
export const messages = pgTable('messages', {
  id: id(),
  ticketId: fk('ticket_id').notNull().references(() => tickets.id, { onDelete: 'restrict' }),
  kind: messageKind('kind').notNull(),
  authorType: actorType('author_type').notNull(),
  authorUserId: fk('author_user_id').references(() => users.id),
  authorCustomerId: fk('author_customer_id').references(() => customers.id),
  recipientUserId: fk('recipient_user_id').references(() => users.id),
  body: text('body').notNull(),
  createdAt: tstz('created_at').notNull().default(sql`clock_timestamp()`),
}, (t) => [
  check('messages_body_chk', sql`length(btrim(${t.body})) > 0 AND length(${t.body}) <= 10000`),
  check('messages_author_chk', sql`
    (${t.authorType} = 'staff'    AND ${t.authorUserId} IS NOT NULL AND ${t.authorCustomerId} IS NULL) OR
    (${t.authorType} = 'customer' AND ${t.authorCustomerId} IS NOT NULL AND ${t.authorUserId} IS NULL) OR
    (${t.authorType} = 'system'   AND ${t.authorUserId} IS NULL AND ${t.authorCustomerId} IS NULL)`),
  check('messages_note_staff_only', sql`${t.kind} = 'public' OR ${t.authorType} = 'staff'`),
  check('messages_recipient_chk', sql`${t.recipientUserId} IS NULL OR ${t.authorType} = 'customer'`),
  index('messages_thread_idx').on(t.ticketId, t.createdAt, t.id),
]);

// ---------- SLA ----------
export const slaCycles = pgTable('sla_cycles', {
  id: id(),
  ticketId: fk('ticket_id').notNull().references(() => tickets.id),
  cycleNo: integer('cycle_no').notNull(),
  isReopen: boolean('is_reopen').notNull().default(false),
  startedAt: tstz('started_at').notNull(),
  clockStartAt: tstz('clock_start_at').notNull(),
  priority: ticketPriority('priority').notNull(),
  replyBudgetMinutes: integer('reply_budget_minutes').notNull(),
  resolveBudgetMinutes: integer('resolve_budget_minutes').notNull(),
  replyDueAt: tstz('reply_due_at').notNull(),
  resolveDueAt: tstz('resolve_due_at').notNull(),
  firstResponseAt: tstz('first_response_at'),
  firstResponseMessageId: fk('first_response_message_id').references(() => messages.id),
  resolvedAt: tstz('resolved_at'),
  endedAt: tstz('ended_at'),
  replyBreachedAt: tstz('reply_breached_at'),
  resolveBreachedAt: tstz('resolve_breached_at'),
}, (t) => [
  unique('sla_cycles_ticket_cycle_uq').on(t.ticketId, t.cycleNo),
  check('sla_cycles_cycle_no_chk', sql`${t.cycleNo} >= 1`),
  check('sla_cycles_budgets_chk', sql`${t.replyBudgetMinutes} > 0 AND ${t.resolveBudgetMinutes} > 0`),
  check('sla_cycles_first_response_pair', sql`(${t.firstResponseAt} IS NULL) = (${t.firstResponseMessageId} IS NULL)`),
  uniqueIndex('sla_cycles_one_active_idx').on(t.ticketId).where(sql`${t.endedAt} IS NULL`),
  index('sla_cycles_reply_due_idx').on(t.replyDueAt)
    .where(sql`${t.endedAt} IS NULL AND ${t.firstResponseAt} IS NULL AND ${t.replyBreachedAt} IS NULL`),
  index('sla_cycles_resolve_due_idx').on(t.resolveDueAt)
    .where(sql`${t.endedAt} IS NULL AND ${t.resolveBreachedAt} IS NULL`),
]);

export const slaPauses = pgTable('sla_pauses', {
  id: id(),
  cycleId: fk('cycle_id').notNull().references(() => slaCycles.id),
  ticketId: fk('ticket_id').notNull().references(() => tickets.id),
  pausedAt: tstz('paused_at').notNull(),
  resumedAt: tstz('resumed_at'),
  businessMinutes: integer('business_minutes'),
}, (t) => [
  check('sla_pauses_minutes_chk', sql`${t.businessMinutes} >= 0`),
  check('sla_pauses_order', sql`${t.resumedAt} IS NULL OR ${t.resumedAt} >= ${t.pausedAt}`),
  check('sla_pauses_closed', sql`(${t.resumedAt} IS NULL) = (${t.businessMinutes} IS NULL)`),
  uniqueIndex('sla_pauses_one_open_idx').on(t.cycleId).where(sql`${t.resumedAt} IS NULL`),
  index('sla_pauses_cycle_idx').on(t.cycleId),
]);

// ---------- audit log (append-only + hash chain: triggers live in the custom migration) ----------
export const ticketEvents = pgTable('ticket_events', {
  id: id(),
  ticketId: fk('ticket_id').notNull().references(() => tickets.id, { onDelete: 'restrict' }),
  chainSeq: integer('chain_seq').notNull(),          // filled by trigger
  type: text('type').notNull(),
  actorType: actorType('actor_type').notNull(),
  actorUserId: fk('actor_user_id').references(() => users.id),
  actorCustomerId: fk('actor_customer_id').references(() => customers.id),
  messageId: fk('message_id').references(() => messages.id),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: tstz('created_at').notNull().default(sql`clock_timestamp()`),
  prevHash: bytea('prev_hash'),
  hash: bytea('hash').notNull(),                     // filled by trigger
}, (t) => [
  unique('ticket_events_chain_uq').on(t.ticketId, t.chainSeq),
  check('ticket_events_type_chk', sql`${t.type} IN (
    'ticket_created','claimed','released','reassigned',
    'public_reply_sent','customer_replied','note_added',
    'status_changed','priority_changed',
    'sla_cycle_started','sla_paused','sla_resumed',
    'reply_breached','resolve_breached',
    'resolved','reopened','auto_closed','closed',
    'linked_ticket_created','export_generated')`),
  check('ticket_events_actor_chk', sql`
    (${t.actorType} = 'staff'    AND ${t.actorUserId} IS NOT NULL AND ${t.actorCustomerId} IS NULL) OR
    (${t.actorType} = 'customer' AND ${t.actorCustomerId} IS NOT NULL AND ${t.actorUserId} IS NULL) OR
    (${t.actorType} = 'system'   AND ${t.actorUserId} IS NULL AND ${t.actorCustomerId} IS NULL)`),
  check('ticket_events_payload_chk', sql`jsonb_typeof(${t.payload}) = 'object' AND NOT (${t.payload} ? 'body')`),
  index('ticket_events_ticket_idx').on(t.ticketId, t.chainSeq),
  index('ticket_events_type_idx').on(t.type, t.createdAt),
]);

// ---------- views (created in the custom migration; declared here so queries are typed) ----------
export const customerTickets = pgView('customer_tickets', {
  id: bigint('id', { mode: 'number' }), ticketNo: integer('ticket_no'),
  accessTokenHash: bytea('access_token_hash'), subject: text('subject'), status: ticketStatus('status'),
  createdAt: tstz('created_at'), resolvedAt: tstz('resolved_at'),
  reopenUntil: tstz('reopen_until'), closedAt: tstz('closed_at'),
}).existing();

export const customerMessages = pgView('customer_messages', {
  id: bigint('id', { mode: 'number' }), ticketId: bigint('ticket_id', { mode: 'number' }),
  accessTokenHash: bytea('access_token_hash'), authorType: actorType('author_type'),
  authorName: text('author_name'), body: text('body'), createdAt: tstz('created_at'),
}).existing();

export const agentTicketList = pgView('agent_ticket_list', {
  id: bigint('id', { mode: 'number' }), ticketNo: integer('ticket_no'), subject: text('subject'),
  priority: ticketPriority('priority'), status: ticketStatus('status'),
  assigneeId: bigint('assignee_id', { mode: 'number' }), customerId: bigint('customer_id', { mode: 'number' }),
  createdAt: tstz('created_at'), updatedAt: tstz('updated_at'),
  waitingSince: tstz('waiting_since'), autoCloseAt: tstz('auto_close_at'), reopenUntil: tstz('reopen_until'),
  cycleId: bigint('cycle_id', { mode: 'number' }), replyDueAt: tstz('reply_due_at'),
  resolveDueAt: tstz('resolve_due_at'), firstResponseAt: tstz('first_response_at'),
  isWaiting: boolean('is_waiting'), isUnclaimed: boolean('is_unclaimed'),
  replyLate: boolean('reply_late'), resolveLate: boolean('resolve_late'), nextDueAt: tstz('next_due_at'),
}).existing();
