# Local adoption verification

Run with an explicitly supplied **already installed** native runtime (containing `pg` and the matching `@embedded-postgres/<platform>-<arch>` package):

```sh
node --test tests/track-b/migration-registry-adoption/pin.test.mjs
node tests/track-b/migration-registry-adoption/run.mjs --runtime /private/tmp/agent-persistence-runtime
```

No package installation occurs. The native runner discards inherited environment before loading pg, creates a fresh disposable PostgreSQL cluster, disables TCP listeners, and connects independent clients over its own Unix socket. It never reads an external DB URL, dotenv file, credential file or provider configuration. All native data and processes are removed in `finally`.

`NATIVE-RESULTS.log` records 12 passing checks with zero skipped, using the locally preinstalled PostgreSQL 18.6 beta package. Cases cover read-only default, explicit owner approval, exact alias-only adoption without duplicate DDL, unknown/conflicting/incomplete evidence, dependencies, reviewed context/file/digest refusal, native SQL rollback, existing unregistered objects, comment-obfuscated transaction controls, exact five additive SQL artifacts, artifact-owned transaction wrappers, independent backend serialization observed through `pg_blocking_pids`, backend termination, immediate server restart and fresh-owner recovery.

The exact five additive SQL artifacts run in a synthetic fixture manifest with explicit predecessor ordering. A binding inserted before authority migration retains NULL authority afterwards. This verifies those native SQL semantics, not the entire historical judged schema, same-role grants, production registry provenance or hosted acceptance. Pin tests independently verify the original 31 application entries, simulator separation, aliases, additive SQL digests and ordered dependencies, and every composed source/canonical copy. They reject changed reviewed input before creating an output directory.

Tests exercise the owner's explicit existing-registry table contract using disposable tables; they never create a production authority or infer historical applied evidence. The scanner is a conservative guard around reviewed SQL, not an arbitrary SQL sandbox.
