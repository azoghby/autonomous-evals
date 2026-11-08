"""Build review artifact from a separately archived and edited integration tree."""
import difflib
import pathlib
import subprocess
import sys

stage = pathlib.Path(sys.argv[1])
base = 'f0068733ca49c37f40fd7de279325f21a4b5fbbb'
paths = [
    'apps/web/src/server/rich-services.ts',
    'apps/web/src/server/workflow-costs.ts',
    'apps/web/src/server/workflow-costs.test.ts',
    'apps/web/src/server/job-store.ts',
    'apps/web/src/server/services.ts',
    'packages/core/src/integration/eval-services.ts',
    'packages/core/src/integration/compose.test.ts',
    'apps/web/migrations/001-workflow-integration.sql',
    'apps/web/src/app/api/operator/jobs/[jobId]/workflow-binding/route.ts',
]
patch = ''
for path in paths:
    result = subprocess.run(['git', 'show', f'{base}:{path}'], capture_output=True, text=True, check=False)
    before = result.stdout if result.returncode == 0 else ''
    after = (stage / path).read_text()
    patch += ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
        fromfile='a/' + path if before else '/dev/null', tofile='b/' + path))
pathlib.Path(__file__).with_name('0001-rich-service-bindings.patch').write_text(patch)
