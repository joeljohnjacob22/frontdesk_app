# tools/

| File | Purpose |
|---|---|
| `start_test_postgres.sh` | Sandbox helper. Starts the throwaway Postgres 16 on port 5433 if it is not running. One-time setup is in `HANDOFF.md` section 9. |
| `build_doc03.py` + `doc03.tpl` | Regenerates `docs/COPILOT_03_AUTH_AND_TICKET_LIFECYCLE.md` from the verified files in `project/`. |
| `build_doc04.py` + `doc04.tpl` | Regenerates `docs/COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md` from the verified Step 04 files in `project/`. |

Docs 01 and 02 are small enough to edit by hand. If you do, re-extract their `file=` / `ref=` blocks into a
clean copy of the project and re-run `npm test`.

Block markers inside the instruction documents:

- ```` ```js file=<path> ```` : create this file verbatim (tests, config, helpers).
- ```` ```js ref=<path> ```` : reference implementation. Use only if the coding agent is stuck.
