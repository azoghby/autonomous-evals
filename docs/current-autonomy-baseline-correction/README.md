# Current autonomy baseline test correction

The current application imports `buildAgentDeps` from `current-agent-deps`.
The historical acceptance fixture mocked only the old core export, so its module
loaded the real current factory and failed collection on `NAIVE_AGENT_ENV`.

Apply `owner.patch` after current-autonomy composition. It mocks the actual
factory import with the same throwing spy, preserves every existing assertion,
and removes the inherited runner exclusion for this test file. Check the exact
preimage/postimage hashes in `PIN.json`; the mounted-chat runner already removes
the exclusion and needs only the test correction.

Parent validation on 2026-11-07: copied only the corrected test into a separate
temporary harness, with aliases pointing at the unchanged complete mounted
candidate `/tmp/current-chat-mount-verified`. Both original tests passed using
actual SQL budgets/fences and fake target transport; offline network guard enabled.
The assertions still prove no legacy runner construction, one reserved Text
dispatch, replay/revocation refusal, and Calendar refusal before dispatch.

No application source, historical artifact, or original test was edited. Full
combined unfiltered verification remains required after applying this correction.
This does not establish hosted or live-provider acceptance.
