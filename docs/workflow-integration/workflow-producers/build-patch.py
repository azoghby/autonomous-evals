from pathlib import Path
import difflib, subprocess
here=Path(__file__).resolve().parent
parts=[]
for f in sorted((here/'files').rglob('*')):
 if not f.is_file(): continue
 p=str(f.relative_to(here/'files'))
 ref='5906961c2a70c0d6d2999cf7086689402ff60f5b' if p.startswith('packages/core/src/') else 'f0068733ca49c37f40fd7de279325f21a4b5fbbb'
 old=subprocess.run(['git','show',ref+':'+p],capture_output=True,text=True)
 parts.append(''.join(difflib.unified_diff(old.stdout.splitlines(True) if old.returncode==0 else [],f.read_text().splitlines(True),fromfile='a/'+p if old.returncode==0 else '/dev/null',tofile='b/'+p)))
(here/'002-workflow-producers.patch').write_text(''.join(parts))
