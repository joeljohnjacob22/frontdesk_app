# Plan 05: Agent UI and Customer Ticket Page

> **Status:** Approved on 2026-11-22, with export links included. Implemented in the active app.

## Purpose and current state

When this plan was drafted, the active app included the Step 04 background tick and per-ticket JSON/CSV exports, while the React app still had placeholders for login, ticket list, ticket detail, new-ticket form, and customer view.

This plan follows the handoff's Step 05 design. It proposes implementing the browser UI only; no API lifecycle changes, schema changes, migrations, or new dependencies are included.

## Proposed scope

### Agent experience

- Login using the existing session API; check `/api/auth/me` on load, redirect unauthenticated users to `/login`, and provide logout.
- Ticket list at `/tickets` with view tabs for open, mine, unclaimed, waiting, late, resolved, and all. Show customer, priority, owner, due information, and Late/Waiting/Mine/Unclaimed badges. Poll every 15 seconds and stop polling when the page unmounts.
- Ticket detail at `/tickets/:id` with the thread, SLA cycles and pauses, and ordered audit timeline. Clearly label notes **Team only** and visually distinguish them from public messages.
- Owner/lead actions using existing API rules: claim, release, reassign (lead only), change priority, resolve, public reply with a “waiting for customer” option, and a separate team-note form.
- New-ticket form at `/new` with impact-based priority labels: “I cannot work at all” (high), “Something is wrong” (medium), and “I have a question” (low).

### Customer experience

- Public ticket page at `/t/:token`, using only the existing customer ticket and message endpoints.
- Show the public thread, status, and a clear “waiting for your reply” state. If the ticket is resolved and `canReopen` is true, explain that sending a reply reopens it; the existing message endpoint performs the reopen.
- Show the new linked-ticket link after a reply creates a new ticket.

### Shared behavior

- Convert API UTC timestamps to Asia/Kolkata for display with `Intl.DateTimeFormat`; never send client timestamps.
- Handle loading, empty, and request-error states. A 401 returns the agent to login; `already_claimed` shows a friendly message and refreshes the ticket; validation errors are shown beside the relevant form.
- Keep server authorization authoritative; client-side route guards are only for user experience.
- Preserve same-origin checks in development. The Vite proxy explicitly forwards the browser's original `Host` header with `changeOrigin: false`.
- Reuse existing Tailwind CSS v4 and React Router setup. Do not add a component library or test dependency.

## Export controls proposed for approval

The Step 04 APIs can already download JSON and CSV for one ticket. The earlier Step 05 handoff design did not specify export buttons. This plan proposes adding small download links on the agent detail and customer ticket pages, with no custom export client or bulk-export UI. Customer links must use the token route and expose no new fields.

If export controls are excluded from this UI step, the APIs remain available and the rest of the UI scope is unchanged.

## Files likely to change

```
client/src/App.jsx             replace placeholders with route-level screens
client/src/api.js              only if a small shared helper is needed
client/src/index.css           optional base styles; Tailwind v4 stays in place
client/src/components/**       small reusable form, status, and message components as needed
client/src/pages/**            login, list, detail, new-ticket, and customer pages
client/vite.config.js          preserve the existing proxy; change only if necessary
```

Keep the component structure small. Do not introduce global state, a data-fetching library, or a new design system for this take-home.

## Implementation and verification sequence

1. **Map UI calls to the existing API.** Confirm route and response shapes in `docs/COPILOT_03_AUTH_AND_TICKET_LIFECYCLE.md` and `docs/COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md`. Do not modify API behavior to fit the UI.
2. **Build shared shell and login.** Add loading/error handling, check the current session, and use the existing login/logout endpoints.
3. **Build ticket list and detail.** Implement view tabs, 15-second polling, status/SLA display, thread, event timeline, and role-appropriate actions. Keep note rendering agent-only.
4. **Build new-ticket and customer pages.** Use the existing ticket creation and token-based customer endpoints. Make the reopen-through-reply behavior explicit.
5. **Add the approved export links.** Use ordinary same-origin download links to the existing attachment endpoints; do not fetch binary responses through the JSON-only helper.
6. **Build and manually verify.** Run the API test suite and client production build. With the local app running, check each route and role, including customer-note privacy, keyboard/form behavior, and timestamps in Asia/Kolkata.

## Acceptance checklist

- `npm test` passes all **123 API tests**; no locked API tests are changed.
- `npm run build` succeeds without installing new dependencies.
- Agent login, logout, session restoration, ticket views, detail actions, lead-only reassignment, and forms work against the existing API.
- Agent notes are visibly marked as internal; customer UI never displays them or queries agent endpoints.
- Customer reply, waiting state, reopen window, and new-linked-ticket outcomes are understandable and usable.
- Displayed timestamps use Asia/Kolkata while the API continues to transmit UTC.
- The Vite proxy retains the original host so the server's `Origin` check continues to work.
- JSON and CSV links work for agent and customer views.

## Out of scope

- Changing business rules, API contracts, database schema, or migrations.
- Pagination, live agent presence, notifications, email delivery, read receipts, and PDF export.
- Adding a component framework, state-management package, or UI test dependency.
- Deployment, hosting selection, demo seed-data design, or README completion (Step 06).

## Approval and completion

The user approved this plan and chose to include export links. The active app now implements the proposed Step 05 UI; no API, schema, migration, or dependency changes were needed.
