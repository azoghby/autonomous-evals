"""Rebuild and check patch against immutable Track A source; no checkout edits."""
from pathlib import Path
import difflib
import subprocess
import tempfile

BASE = '07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f'
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VIEW = 'apps/web/src/components/app/job-view.tsx'
original = subprocess.check_output(['git', 'show', f'{BASE}:{VIEW}'], cwd=ROOT, text=True)
updated = original
updated = updated.replace('import { ReportView } from "./job-report";', 'import { ReportView } from "./job-report";\nimport { JobProgressChat } from "./job-progress-chat";\nimport { useProgressChatTransport } from "@/lib/client/progress-chat";')
updated = updated.replace('  const router = useRouter();', '  const router = useRouter();\n  // Stable, explicit injection seam. No endpoint is called until Track A supplies it.\n  const chatTransport = useProgressChatTransport();')
updated = updated.replace('      {EXPLAIN[current] && (', '      <JobProgressChat key={`${jobId}:${chatTransport?.authScopeKey ?? "unavailable"}`} jobId={jobId} transport={chatTransport} />\n\n      {EXPLAIN[current] && (')
assert updated != original
files = {
 VIEW: (original, updated),
 'apps/web/src/components/app/job-progress-chat.tsx': ('', (HERE/'component/job-progress-chat.tsx').read_text()),
 'apps/web/src/lib/client/progress-chat.ts': ('', (HERE/'component/progress-chat.ts').read_text()),
}
patch = ''.join(''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile=f'a/{path}' if old else '/dev/null', tofile=f'b/{path}')) for path, (old, new) in files.items())
# Git accepts empty context lines without the optional space prefix. This keeps
# the patch artifact itself free of trailing whitespace.
patch = ''.join('\n' if line == ' \n' else line for line in patch.splitlines(True))
(HERE/'track-a-progress-chat.patch').write_text(patch)
with tempfile.TemporaryDirectory(prefix='progress-chat-apply-') as temp:
 for path, (old, _) in files.items():
  if old:
   p=Path(temp)/path; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(old)
 subprocess.run(['git','apply','--check',str(HERE/'track-a-progress-chat.patch')],cwd=temp,check=True)
 subprocess.run(['git','apply',str(HERE/'track-a-progress-chat.patch')],cwd=temp,check=True)
 for path, (_, new) in files.items():
  assert (Path(temp)/path).read_text() == new, path
print(f'Patch applied and exact output verified against {BASE}: {len(files)} files')
