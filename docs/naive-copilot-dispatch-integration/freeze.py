"""Refresh this additive candidate's hashes/patch. Does not apply source or SQL."""
import difflib, hashlib, json, pathlib

a = pathlib.Path(__file__).resolve().parent
p = a.parent / 'naive-internal-mcp-integration'
sha = lambda data: hashlib.sha256(data).hexdigest()
files, patch = [], []
for source in sorted((a / 'postimages').rglob('*.ts')):
    path = source.relative_to(a / 'postimages').as_posix()
    data = source.read_bytes()
    files.append({'path': path, 'postimage': source.relative_to(a).as_posix(),
                  'beforeSha256': None, 'afterSha256': sha(data)})
    patch.append('diff --git a/' + path + ' b/' + path + '\nnew file mode 100644\n')
    patch.extend(difflib.unified_diff([], data.decode().splitlines(True),
                                    fromfile='/dev/null', tofile='b/' + path))
manifest = {
    'reviewedRepositoryCommit': '2f921db',
    'status': 'unapplied_incremental_candidate',
    'requires': 'naive-internal-mcp-integration',
    'dependencyHashes': {path: sha((p / path).read_bytes()) for path in
                         ['manifest.json', 'assemble.py', 'validation/baseline-pins.json']},
    'files': files,
    'sql': [{'path': path.relative_to(a).as_posix(), 'sha256': sha(path.read_bytes())}
            for path in sorted((a / 'sql').glob('*.sql'))],
}
(a / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(a / 'owner.patch').write_text(''.join(patch))
print(f'{len(files)} additive source/test paths; SQL separate and unapplied')
