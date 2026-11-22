# Plan: Customer Authentication and UI Improvements

**Status:** Approved and implemented on 2026-11-22, with the historical-ticket and password-reset behavior confirmed below.

## Context

The active app has agent and lead accounts, while customers currently submit tickets anonymously and use private token links to view and reply. The user requested a more welcoming interface, a real home page, customer login before ticket creation, role-based access, and usable test credentials.

The user selected self-registration without email verification, disabled private ticket links, requested a demo customer login, confirmed that historical tickets stay available to staff but not customers, and chose lead-issued temporary passwords for account recovery. This plan follows those choices; it does not add an email provider.

## Proposed behavior

### Accounts and roles

- One login flow supports `customer`, `agent`, and `lead`; redirect each role to its own landing page.
- Public customer registration accepts name, email, and password. The server assigns the `customer` role; the client cannot choose a role.
- Customer actions require an active customer session. A customer can create tickets and read/reply only to tickets in that account's scope.
- Agent and lead APIs remain restricted to staff. Leads retain lead-only reassign and team-management actions.
- Do not allow unauthenticated ticket creation. Do not accept customer identity fields from a ticket-create request; derive the identity from the session.

### Customer ticket access and privacy

- Replace the customer token-link page and token-based export access with authenticated customer ticket list/detail/reply/export routes.
- Customer reads continue to use explicitly shaped customer-only database views; never select team notes or expose internal fields.
- Do not automatically grant an unverified new account access to historical tickets just because its email matches a legacy customer record. Scope customer access to tickets created after that account was registered.
- Because private links are disabled, pre-existing tickets remain visible to agents but are not customer-accessible in this step. Releasing historical tickets to customers later requires a separate identity-proofing process.

### Passwords and demo access

- Hash passwords with the existing `bcryptjs`; validate registration and login inputs, use generic login failures, and re-check active accounts on each request.
- Add an authenticated change-password flow. A lead can issue a randomly generated temporary password to a customer; show it only once and require a password change at next login.
- Seed one local/test customer account using the existing `SEED_PASSWORD` configuration. Document demo logins for the customer, an agent, and a lead; never treat example credentials as production credentials.
- Keep account roles out of public registration, customer-facing ticket responses, exports, and list results for other customers.

### Interface

- Replace the API-status home screen with a welcoming support landing page and clear sign-in, registration, and ticket actions. Keep `/api/health` for operational health checks.
- Add customer registration/login and a customer portal with ticket list, ticket detail, reply, and new-ticket forms.
- Refresh the visual design across the customer and agent areas with consistent layout, readable status/priority treatments, responsive navigation, empty/loading/error states, and accessible forms.
- Keep the agent workspace and its existing workflows intact while making its navigation and visual hierarchy consistent with the new shell.

## Data and API work

- Extend the role/account model with a customer association and a forced-password-change flag, using `db/schema.js` and a newly generated Drizzle migration. Never edit an applied migration and never run `drizzle-kit push`.
- Add customer-account-only read views (including safe message rows) and grant the restricted customer database role access only to those views.
- Add customer registration, role-aware login/session guards, authenticated ticket list/detail/create/reply/export endpoints, password change, and lead-only temporary-password reset.
- Remove public token-based customer reads/writes/exports from the active app. Existing token hashes may remain stored; no raw token is returned.
- Update the frontend API helper and route guards for the role-based session flow.

## Verification

- Add focused database/API tests for registration, duplicate emails, password hashing, role restrictions, anonymous-create rejection, cross-customer IDOR attempts, legacy-ticket isolation, public-token-route rejection, password change, lead-only temporary-password reset, and forced password change at next login.
- Extend privacy coverage to prove customer list/detail/thread/export cannot return another account's tickets, team notes, access-token hashes, or staff secrets.
- Run all tests against the throwaway test database, including migration and restricted-role tests; never use the real database for tests.
- Build the production client and manually verify signup, login/logout, customer/agent/lead routing, ticket creation, own-ticket access, role-denied routes, and responsive layout.
- Verify that the demo account works from a freshly seeded local database and document its credentials and limitations.

## Explicit limitations for approval

- Unverified self-registration does not prove control of the email address. A registrant can claim a new account under an arbitrary email, but cannot inherit historical tickets through that email.
- With no email provider, there is no email verification or emailed recovery. Forgotten passwords are handled by a lead issuing a one-time temporary password; the customer must replace it at next login.
- Historical customer tickets will not be available in the customer portal after private-link access is removed. Agents retain access.

## Approval

The user approved implementation with the limitations and recovery workflow documented above.

## Implementation and verification record

- Added customer registration, role-aware sessions, customer-owned ticket access, password changes, and lead-issued temporary passwords.
- Replaced anonymous customer ticket creation and private-link HTTP access with authenticated customer routes.
- Added the customer portal and welcoming home page, and retained the agent workspace with lead-only customer management.
- The demo customer seed is disabled in production; local credentials and setup are in [LOCAL_TEST_CREDENTIALS.md](../LOCAL_TEST_CREDENTIALS.md).
- `npm test`: 128 passed; `TZ=America/Los_Angeles npm test`: 128 passed.
- `npm --prefix client run build`: passed.
- Browser verification covered customer sign-in and ticket creation/detail plus agent sign-in, queue, and ticket detail.
- `docs/smoke.sh` passed against a freshly migrated and seeded disposable database, including anonymous-create rejection and the private-note check.
- Follow-up UI refinement: both agent and customer ticket details now use a chat layout with a collapsible details/actions sidebar. Customer tickets sort by latest public-message activity; a "New reply" badge remains until the customer replies. Agent lists retain SLA-first ordering.
