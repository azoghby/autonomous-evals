Run against an already composed and patched candidate:

```sh
node tests/track-b/current-chat-mount/ui/run.mjs <absolute-stage> <owned-evidence-directory>
```

The runner performs no source corrections. It copies the staged JobView, JobPrivateChat and useLiveJob bytes, records SHA-256 digests, and runs an offline React/jsdom harness using the existing `/tmp/progress-chat-ui-verification/node_modules` installation (override with `CHAT_UI_NODE_MODULES`). No dependency installation or provider/network requests are used. The targeted TypeScript check covers the independent interaction suite and real chat component; the integration owner must run full application typecheck/build separately.

`interactions.test.tsx` adds loading without invented progress, native focus/form semantics, safe errors/history retry, revocation with stale sends, cross-job stale history/poll isolation and responsive wrapping primitives. jsdom cannot verify default keyboard activation/tab order, real responsive pixel layout, computed CSS, screenshots, or deployed authorization. The keyboard check dispatches native form submission after focusing the submit button; responsive checks assert existing wrapping classes only.

`job-bindings.test.tsx` renders the real staged JobView and real chat component. It stubs authenticated detail and live hook boundaries, navigation, layout and legacy child components so tests can observe job ID binding, denied/loading/mismatched guards, terminal-state mounting, and independent rich/legacy progress. It does not claim end-to-end server authentication or full legacy child rendering.

The unchanged existing `chat.test.tsx` and `reauth.test.tsx` originate in `tests/track-b/chat-workflow-release/ui/`. `privacy.test.tsx` and `hook.test.tsx` are unchanged copies of the privacy team's `tests/track-b/chat-current-authority/privacy/` checks; the final composition manifest pins the reviewed privacy artifact commit. The hook suite uses the real applied hook with fixture transports and checks job switch, old callbacks, disabled reads and late old-job failures.

No browser, external page, provider, cloud, database or deployed session is exercised. Synthetic API responses explicitly represent persisted records with unknowns; they are test fixtures rather than product progress claims.
