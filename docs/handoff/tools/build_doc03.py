#!/usr/bin/env python3
"""Regenerates docs/COPILOT_03_AUTH_AND_TICKET_LIFECYCLE.md from the VERIFIED project files.

Why: the instruction documents embed the test files and a reference implementation. They are generated
from the real files in ../project so the document and the code can never drift apart.

Workflow: edit a file in project/  ->  run the tests  ->  run this script  ->  re-extract the document's
blocks into a clean copy and re-run the tests.

Usage:  python3 tools/build_doc03.py
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
project = root / 'project'
tpl = (root / 'tools' / 'doc03.tpl').read_text()


def read(rel):
    return (project / rel).read_text().rstrip('\n') + '\n'


# @@FILE path@@  -> the file's current content (used for tests, helpers and the smoke script)
tpl = re.sub(r"@@FILE (\S+)@@\n", lambda m: read(m.group(1)), tpl)

# @@REFS@@ -> the reference implementation appendix
refs = [
    'server/lib/errors.js', 'server/lib/format.js', 'server/lib/tokens.js', 'server/lib/validate.js',
    'server/lib/session.js', 'server/services/events.js', 'server/services/tickets.js',
    'server/services/queries.js', 'server/middleware/auth.js', 'server/routes/auth.js',
    'server/routes/agent.js', 'server/routes/customer.js', 'server/app.js', 'server/index.js',
]
tpl = tpl.replace('@@REFS@@', "\n".join(f"```js ref={p}\n{read(p)}```\n" for p in refs))

out = root / 'docs' / 'COPILOT_03_AUTH_AND_TICKET_LIFECYCLE.md'
out.write_text(tpl)
print('wrote', out, len(tpl.splitlines()), 'lines')
