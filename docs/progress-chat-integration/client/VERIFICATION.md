UI patch base: `96cb4adcea8c55ae4d8cc353deb059996245aa77` (local origin/track-a at inspection; no fetch).

Preserves Track A's existing black/blue tokens, readable muted text, hairline panels and 4px corners. Adds the private section within the job page's main column, during evaluation and after delivery, using the existing layout rather than a separate floating widget. The clarification endpoint is untouched. Replies display as plain escaped text, never HTML, links, input digests or evidence bodies. The UI deliberately says answers are retained and questions are not: core stores only the question digest. Drafts and failed attempts live only in component memory and reset across job navigation.

Run offline with installed test dependencies:

```sh
CHAT_UI_NODE_MODULES=/tmp/progress-chat-ui-verification/node_modules node docs/progress-chat-integration/client/tests/run.mjs
```

Set `CHAT_STAGE_DIR` to the disposable patched app tree to test its applied component; otherwise the source artifact is tested. The runner copies owned source/fixtures into a disposable temporary directory, symlinks the specified installed dependencies, then runs `tsc --noEmit` and Vitest/jsdom. No dependency download is attempted. Verified with React 19.2.0, TypeScript 5.9.3, Vitest 3.2.4 and jsdom 26.1.0. Target Track A declares React 19.3.0: full application typecheck/build remains an integration check.

Passed: 9 interaction fixtures covering load/empty/privacy states, progress polling independent from history cursor, pagination, stable retry identity after network failure, fixed authorization errors, job navigation state isolation, UTF-8 input bound React StrictMode replay and clearing already-loaded private answers when authorization is later denied. Patch `git apply --check` and apply also passed in an archive of the exact base.

No screenshot, visual browser inspection, full Next app build or live endpoint verification was performed. The local offline harness has no installed Next app runtime. Owner should inspect desktop/mobile rendered placement with the real authenticated job page after applying the patch and completing server setup.

`build-patch.py` regenerates `../client.patch` solely from the pinned local git object and the source artifact. Tests remain review artifacts under this directory so application dependencies and root test configuration need no changes.
