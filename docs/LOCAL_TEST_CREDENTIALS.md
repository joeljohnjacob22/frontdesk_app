# Local test logins

After applying migrations and running `npm run db:seed`, these accounts are available outside production:

| Role | Email |
|---|---|
| Lead | `meera@arvo.test` |
| Agent | `anil@arvo.test` |
| Customer | `customer@arvo.test` |

The password for all three is the value of `SEED_PASSWORD`. If unset, the local default is `frontdesk-demo`. Change it in your local `.env` before seeding if you prefer a different password.

Seeding is idempotent and does not change passwords for accounts that already exist. To use a changed `SEED_PASSWORD` for an existing account, change its password through the app or reset the local test database and seed it again.

The seeded demo customer is intentionally omitted when `NODE_ENV=production`. Customers can still register through the app. Do not use the example local password for a deployed environment.

After sign-in, a lead can add agents from **Team**. Each new agent receives a one-time temporary password and must change it at first sign-in.
