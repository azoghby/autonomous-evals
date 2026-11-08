"""Use an already completed root npm ci; keep workspace dependencies and stage core."""
import pathlib,shutil,os,json,hashlib
r=pathlib.Path.cwd();o=r/'docs/naive-operator-current-integration';s=pathlib.Path('/tmp/naive-operator-current-stage')
d=s/'node_modules'
if d.is_symlink():d.unlink()
elif d.exists():shutil.rmtree(d)
d.mkdir()
for p in (r/'node_modules').iterdir():
 if p.name!='@ae':os.symlink(p,d/p.name)
(d/'@ae').mkdir();os.symlink(s/'packages/core',d/'@ae/core')
for top in ['apps/web','packages/core']:
 dest=s/top/'node_modules'
 if dest.is_symlink():dest.unlink()
 elif dest.exists():shutil.rmtree(dest)
 dest.mkdir()
 for p in (r/top/'node_modules').iterdir():os.symlink(p,dest/p.name)
