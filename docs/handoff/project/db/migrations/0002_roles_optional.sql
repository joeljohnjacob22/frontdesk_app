-- OPTIONAL hardening. Skips itself (with a NOTICE) on hosts that do not let the
-- migration user create roles, so it can never block a deploy.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_app') THEN
    CREATE ROLE frontdesk_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_customer_reader') THEN
    CREATE ROLE frontdesk_customer_reader NOLOGIN;
  END IF;

  -- Main application role: full working access, but cannot modify history.
  GRANT SELECT, INSERT, UPDATE ON users, customers, tickets, sla_cycles, sla_pauses,
        sla_policies, holidays, settings TO frontdesk_app;
  GRANT SELECT, INSERT ON messages, ticket_events TO frontdesk_app;   -- no UPDATE/DELETE
  GRANT SELECT ON customer_tickets, customer_messages, agent_ticket_list TO frontdesk_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO frontdesk_app;

  -- Customer READ role: sees two views and nothing else.
  GRANT SELECT ON customer_tickets, customer_messages TO frontdesk_customer_reader;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping optional DB roles (insufficient privilege): %', SQLERRM;
END $$;
