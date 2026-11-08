Run from the repository root:

```sh
node --test tests/track-b/release-registry-reconciliation/*.test.mjs
```

The pure tests load the immutable judged-release manifest with all 31 application
migrations and its isolated simulator entry. Inventory hashes and owner exports
are synthetic test inputs. CLI tests create temporary SQL files with deliberately
synthetic hashes, exercise real file reads, and compare input bytes before and
after. They do not execute SQL, contact a database, or establish hosted acceptance.
