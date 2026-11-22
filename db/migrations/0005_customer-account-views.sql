-- Custom SQL migration file, put your code below! --
DROP VIEW customer_messages;
DROP VIEW customer_tickets;
--> statement-breakpoint
CREATE VIEW customer_tickets AS
SELECT
  t.id,
  t.customer_id,
  t.ticket_no,
  t.subject,
  t.status,
  t.created_at,
  t.resolved_at,
  t.reopen_until,
  t.closed_at
FROM tickets t;
--> statement-breakpoint
CREATE VIEW customer_messages AS
SELECT
  m.id,
  m.ticket_id,
  t.customer_id,
  m.author_type,
  CASE m.author_type
    WHEN 'staff' THEN u.name
    WHEN 'customer' THEN c.name
    ELSE 'Frontdesk'
  END AS author_name,
  m.body,
  m.created_at
FROM messages m
JOIN tickets t ON t.id = m.ticket_id
LEFT JOIN users u ON u.id = m.author_user_id
LEFT JOIN customers c ON c.id = m.author_customer_id
WHERE m.kind = 'public';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_app') THEN
    EXECUTE 'GRANT SELECT ON customer_tickets, customer_messages TO frontdesk_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_customer_reader') THEN
    EXECUTE 'GRANT SELECT ON customer_tickets, customer_messages TO frontdesk_customer_reader';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping customer view grants (insufficient privilege): %', SQLERRM;
END $$;