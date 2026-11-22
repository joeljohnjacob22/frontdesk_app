#!/usr/bin/env python3
"""Generate the Step 04 Copilot guide from its verified reference files."""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
project = root / 'project'
template = (root / 'tools' / 'doc04.tpl').read_text()


def read(rel):
    return (project / rel).read_text().rstrip('\n') + '\n'


template = re.sub(r"@@FILE (\S+)@@\n", lambda match: read(match.group(1)), template)
refs = [
    'server/jobs/tick.js',
    'server/services/exports.js',
    'server/routes/agent.js',
    'server/routes/customer.js',
    'server/app.js',
    'server/index.js',
]
template = template.replace(
    '@@REFS@@',
    '\n'.join(f"```js ref={path}\n{read(path)}```\n" for path in refs),
)

output = root.parent / 'COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md'
output.write_text(template)
print('wrote Step 04 guide:', len(template.splitlines()), 'lines')
