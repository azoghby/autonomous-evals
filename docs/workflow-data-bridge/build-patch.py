"""Build bridge diff from exact prerequisite stage/source copies; no checkout edits."""
from pathlib import Path
import difflib
import subprocess
import json
root = Path(__file__).resolve().parents[2]
here = Path(__file__).resolve().parent
stage = Path(json.loads(subprocess.check_output(['node', str(here / 'stage.mjs'), '--before-bridge'], cwd=root))['stage'])
parts = []
for source in sorted((here / 'source').rglob('*')):
    if not source.is_file(): continue
    path = source.relative_to(here / 'source').as_posix()
    original = stage / path
    parts.extend(difflib.unified_diff(original.read_text().splitlines(True) if original.exists() else [], source.read_text().splitlines(True), fromfile='a/' + path if original.exists() else '/dev/null', tofile='b/' + path))
(here / 'bridge.patch').write_text(''.join(parts))
print(stage)
