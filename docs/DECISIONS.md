# Decisions log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-21 | Use `bcryptjs` for password hashing. | Pure JavaScript avoids native build requirements on deployment hosts. |
| 2026-11-21 | Run tests with plain `node --test`, without a directory argument. | Node 22 does not support a directory argument such as `tests/`. |
| 2026-11-21 | Run database migrations as part of `npm start`. | Each deployment brings the database schema up to date before starting the server. |
