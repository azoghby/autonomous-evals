from pathlib import Path
import difflib
root = Path(__file__).resolve().parent
files = root / 'files'
base = root.parents[1] / 'progress-chat-integration/server/files/apps/web/src/server/progress-chat.ts'
old = base.read_text()
new = old.replace('import "server-only";', 'import "server-only";\nimport { readStructuredProgress } from "./structured-progress";')
new = new.replace('const snapshot = mapSnapshot(job, events.rows, findings.rows, costs.rows, key, me.id);', '''const appSnapshot = mapSnapshot(job, events.rows, findings.rows, costs.rows, key, me.id);
    const structured = await readStructuredProgress(tx, { subjectId: me.id, jobId }, job, key, knownSecrets, appSnapshot.observedAt);
    const snapshot = structured ? { ...structured, blockers: [...structured.blockers, ...appSnapshot.blockers], costs: appSnapshot.costs, unknownCosts: true } : appSnapshot;''')
out = ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/apps/web/src/server/progress-chat.ts', tofile='b/apps/web/src/server/progress-chat.ts'))
for source in sorted(files.rglob('*.ts')):
    target = source.relative_to(files).as_posix()
    out += ''.join(difflib.unified_diff([], source.read_text().splitlines(True), fromfile='/dev/null', tofile='b/'+target))
(root/'structured-progress.patch').write_text(out)
