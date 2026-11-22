-- Custom migration: everything Drizzle's schema DSL cannot express.
-- Safe to read top to bottom; each block is independent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() for the hash chain

-- ===== shared trigger functions =====
-- Shared trigger functions
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- ===== triggers on ordinary tables =====
CREATE TRIGGER users_updated_at   BEFORE UPDATE ON users   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tickets are never deleted.
CREATE TRIGGER tickets_no_delete   BEFORE DELETE   ON tickets FOR EACH ROW       EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER tickets_no_truncate BEFORE TRUNCATE ON tickets FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- messages: append-only
CREATE TRIGGER messages_no_update   BEFORE UPDATE   ON messages FOR EACH ROW       EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER messages_no_delete   BEFORE DELETE   ON messages FOR EACH ROW       EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER messages_no_truncate BEFORE TRUNCATE ON messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- ===== audit log: hash chain + append-only =====
-- Canonical hash of one event. Deterministic, and independent of session timezone.
CREATE FUNCTION compute_event_hash(p_prev bytea, e ticket_events) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT digest(
    coalesce(encode(p_prev, 'hex'), '') || '|' || e.ticket_id::text || '|' || e.chain_seq::text || '|' ||
    e.type || '|' || e.actor_type::text || '|' ||
    coalesce(e.actor_user_id::text, '') || '|' || coalesce(e.actor_customer_id::text, '') || '|' ||
    coalesce(e.message_id::text, '') || '|' || e.payload::text || '|' ||
    extract(epoch FROM e.created_at)::text,
    'sha256')
$$;

-- Runs before every insert: serialises per ticket, assigns the sequence and the
-- timestamp *after* the lock (so order matches time), then chains the hash.
CREATE FUNCTION ticket_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_seq  integer;
  v_prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(NEW.ticket_id);
  SELECT chain_seq, hash INTO v_seq, v_prev
    FROM ticket_events WHERE ticket_id = NEW.ticket_id
    ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq  := coalesce(v_seq, 0) + 1;
  NEW.created_at := clock_timestamp();
  NEW.prev_hash  := v_prev;
  NEW.hash       := compute_event_hash(v_prev, NEW);
  RETURN NEW;
END $$;

CREATE TRIGGER ticket_events_chain_bi BEFORE INSERT ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION ticket_events_chain();

CREATE TRIGGER ticket_events_no_update   BEFORE UPDATE   ON ticket_events FOR EACH ROW       EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER ticket_events_no_delete   BEFORE DELETE   ON ticket_events FOR EACH ROW       EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER ticket_events_no_truncate BEFORE TRUNCATE ON ticket_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- Integrity check: returns one row per event. Any ok = false means tampering.
CREATE FUNCTION verify_ticket_chain(p_ticket_id bigint)
RETURNS TABLE (chain_seq integer, ok boolean) LANGUAGE sql STABLE AS $$
  SELECT e.chain_seq,
         (e.prev_hash IS NOT DISTINCT FROM lag(e.hash) OVER (ORDER BY e.chain_seq))
         AND e.hash = compute_event_hash(e.prev_hash, e)
  FROM ticket_events e
  WHERE e.ticket_id = p_ticket_id
  ORDER BY e.chain_seq
$$;

-- ===== views =====

-- Customer-facing ticket header. No assignee, priority, SLA or internal fields.
CREATE VIEW customer_tickets AS
SELECT t.id, t.ticket_no, t.access_token_hash, t.subject, t.status,
       t.created_at, t.resolved_at, t.reopen_until, t.closed_at
FROM tickets t;

-- The ONLY way the customer side reads messages. Notes cannot appear here.
CREATE VIEW customer_messages AS
SELECT m.id, m.ticket_id, t.access_token_hash,
       m.author_type,
       CASE m.author_type WHEN 'staff' THEN u.name WHEN 'customer' THEN c.name ELSE 'Frontdesk' END AS author_name,
       m.body, m.created_at
FROM messages m
JOIN tickets t         ON t.id = m.ticket_id
LEFT JOIN users u      ON u.id = m.author_user_id
LEFT JOIN customers c  ON c.id = m.author_customer_id
WHERE m.kind = 'public';

-- Agent list: one row per ticket, with late/waiting flags computed at READ time
-- (so correctness never depends on the tick job having run). Contains NO message text.
CREATE VIEW agent_ticket_list AS
SELECT
  t.id, t.ticket_no, t.subject, t.priority, t.status,
  t.assignee_id, t.customer_id, t.created_at, t.updated_at,
  t.waiting_since, t.auto_close_at, t.reopen_until,
  c.id AS cycle_id, c.reply_due_at, c.resolve_due_at, c.first_response_at,
  (t.status = 'waiting_on_customer')                          AS is_waiting,
  (t.assignee_id IS NULL AND t.status IN ('new', 'open'))     AS is_unclaimed,
  (
    c.reply_breached_at IS NOT NULL OR
    (c.ended_at IS NULL AND c.first_response_at IS NULL
       AND t.status <> 'waiting_on_customer' AND now() > c.reply_due_at)
  ) AS reply_late,
  (
    c.resolve_breached_at IS NOT NULL OR
    (c.resolved_at IS NOT NULL AND c.resolved_at > c.resolve_due_at) OR
    (c.ended_at IS NULL AND t.status <> 'waiting_on_customer' AND now() > c.resolve_due_at)
  ) AS resolve_late,
  -- Sort key: the next deadline that still matters. NULL when nothing is running.
  CASE
    WHEN c.id IS NULL OR c.ended_at IS NOT NULL OR t.status = 'waiting_on_customer' THEN NULL
    WHEN c.first_response_at IS NULL THEN c.reply_due_at
    ELSE c.resolve_due_at
  END AS next_due_at
FROM tickets t
LEFT JOIN LATERAL (
  SELECT * FROM sla_cycles s WHERE s.ticket_id = t.id ORDER BY s.cycle_no DESC LIMIT 1
) c ON true;

-- ===== seed data =====
INSERT INTO settings (key, value, description) VALUES
  ('timezone',                    'Asia/Kolkata', 'Business timezone (no DST)'),
  ('work_start',                  '09:30',        'Working day start'),
  ('work_end',                    '18:30',        'Working day end (9 h = 540 min/day)'),
  ('work_days',                   '1,2,3,4,5',    'ISO weekdays, Mon=1'),
  ('auto_close_business_minutes', '2700',         '5 working days waiting on customer'),
  ('reopen_business_minutes',     '2700',         '5 working days after resolve');

INSERT INTO sla_policies (priority, reply_minutes, resolve_minutes, resolve_same_day) VALUES
  ('high',    120,  NULL, true),    -- reply 2 h; resolve same working day
  ('medium',  270,  1620, false),   -- reply half a day (4.5 h); resolve ~3 working days
  ('low',     540,  2700, false);   -- reply 1 working day; resolve ~5 working days

-- Fixed-date national holidays only. Floating festivals (Onam, Vishu, Diwali, Eid...) change
-- every year: add them from an official Kerala government list before go-live.
INSERT INTO holidays (holiday_date, name) VALUES
  ('2026-12-25', 'Christmas Day'),
  ('2027-01-26', 'Republic Day'),
  ('2027-08-15', 'Independence Day'),
  ('2027-10-02', 'Gandhi Jayanti');
