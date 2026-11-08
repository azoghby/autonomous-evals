#!/usr/bin/env python3
"""Rebuild the UI patch from pinned local objects, with no app checkout writes."""
from pathlib import Path
import difflib
import subprocess
BASE = '96cb4adcea8c55ae4d8cc353deb059996245aa77'
HERE = Path(__file__).resolve().parent
path = 'apps/web/src/components/app/job-view.tsx'
old = subprocess.check_output(['git', 'show', f'{BASE}:{path}'], text=True)
new = old.replace('import { AgentFeed } from "./agent-feed";', 'import { AgentFeed } from "./agent-feed";\nimport { JobPrivateChat } from "./job-private-chat";')
needle = '          {EXPLAIN[current] && ('
assert new.count(needle) == 1
new = new.replace(needle, '          <JobPrivateChat jobId={jobId} />\n\n' + needle)
chunks = ['diff --git a/'+path+' b/'+path+'\n', ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/'+path, tofile='b/'+path))]
path = 'apps/web/src/components/app/job-private-chat.tsx'
content = (HERE/'source/job-private-chat.tsx').read_text()
chunks += ['diff --git a/'+path+' b/'+path+'\nnew file mode 100644\n', ''.join(difflib.unified_diff([], content.splitlines(True), fromfile='/dev/null', tofile='b/'+path))]
(HERE.parent/'client.patch').write_text(''.join(chunks))
