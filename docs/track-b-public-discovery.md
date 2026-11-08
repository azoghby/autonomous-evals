# Track B public-source discovery

This server-side adapter performs bounded MediaWiki Action API search and revision retrieval through HTTPS GET. It fills the live-discovery gap described in the earlier [data adapters document](track-b-data-adapters.md); that document's statement that no adapter searches publicly describes the earlier registry implementation. The verified registry remains a separate authenticated review mechanism.

The provider choice follows primary official documentation: [Search](https://www.mediawiki.org/wiki/API:Search) describes GET search and its `srlimit` result bound; [Revisions](https://www.mediawiki.org/wiki/API:Revisions) describes retrieval by `pageids`, revision content and `rvslots=main`. The adapter uses JSON `formatversion=2`. Configuration can name a public Wikimedia deployment such as `https://en.wikipedia.org`; it requires no API token. Documentation was read, but no live search or revision request was used to validate fixtures. The [Wikimedia User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) applies to deployment traffic; operators must provide truthful public application contact information when required by the provider.

## Retrieval and trust boundary

Provider origin and queries are explicit server configuration. Source text, search titles, URLs, links and embedded instructions never select a network destination. Requests use fixed `/w/api.php` paths on the configured HTTPS origin. Search results supply numeric page IDs for a single batched revision request. Pagination and additional links are not followed. Source provenance uses a revision-specific `/w/index.php?oldid=<revision-id>` URL constructed on that same origin, not a URL returned by source content.

Stored content is raw, untrusted revision wikitext, with SHA-256 of the exact stored string, a retrieval timestamp and public-provider lineage. The adapter emits candidate `DataSource` records with pending review, unknown permission and no allowed uses. It emits no evaluation cases and no answer verification. Public availability, a successful TLS request, a content hash and a permanent revision URL do not establish factual correctness, attribution compliance, legal permission or independent approval. Independent reviewers must resolve permission and review the immutable evidence snapshot; factual answers still require the existing independent-evidence or qualified, consented expert gates and context bindings.

The GET transport preserves the target transport's public-address DNS screening, rejects any mixed public/private DNS set, connects to the validated numeric address, and checks TLS against the original host with original Host/SNI identity. It disables agent pooling, follows no redirects and accepts no compressed response. Its deadline includes DNS resolution and its URL-request and response byte bounds are enforced before admission. The existing POST target URL policy continues to reject query strings. The GET policy permits queries only on its configured origin.

## Durable operation ownership

The application must supply a durable atomic operation store. It must bind each operation key to the complete request/configuration fingerprint, admit one claim before any network request, reject key reuse with a different fingerprint, and persist the complete result atomically. A competing or previously claimed incomplete operation returns pending; it does not start another search. A failure after claim can be ambiguous, including a crash after retrieval but before result persistence. Such an operation remains pending for explicit operator reconciliation; elapsed time does not authorize a retry. Do not implement the production store as an in-memory map or an expiring lease that silently repeats work.

The required `DiscoveryOperations` port has `claim(key, digest)` returning `{state:'claimed'}`, `{state:'pending'}`, `{state:'complete', data:DataBatch}`, or `{state:'rejected', rejection:{reasons:DiscoveryRejectionReason[]}}`, and `complete(key, digest, data): Promise<void>`. Only the first atomic successful claim may return `claimed`; `complete` must match the stored digest and retain immutable completed data. The fingerprint includes versioned provider/query/limit/contact identity plus the entire acquisition request. It is a canonical integrity binding, not authentication. The adapter neither provisions this store nor proves an injected implementation is durable.

Persist operation records under the same authorization, retention, integrity and secret-screening policy as evaluation evidence. Cached results remain candidates and must be re-screened against current known secrets before returning them. A durable cache is an idempotency boundary, not a reviewer. Injected transport and stores are trusted server dependencies; fixture implementations do not demonstrate production durability or network protection.

### Terminal unusable retrieval

`DiscoveryOperations.reject?(key, digest, rejection)` durably records a terminal refusal under the same immutable digest and owner token as completion. The optional method preserves compatibility with legacy operation stores; without it, a definitive rejection throws `public_discovery_rejection_storage_unavailable` and stays pending. Upgrade stores before relying on fallback. The SQL factory implements it without a migration. Existing completed batches remain readable.

New definitive rejections return `{status:'rejected', rejection:{reasons:[...]}}`, with no data field. Reasons are a nonempty unique list drawn only from `invalid_response`, `content_limit_exceeded`, `pii_detected`, `secret_detected`, and `unsafe_data`. No exception text, matched values, page identifiers, source content, URLs or rejected content hashes are retained. A safety flag reports the screen's decision, not proof of actual personal information. The adapter conservatively rejects the entire bounded retrieval batch if any candidate fails admission; it does not salvage partially validated responses. Independent successful retrievals retain the existing pending-review, unknown-permission behavior.

Acquisition records `discovery_rejected` plus the fixed diagnostics in its durable decision history and advances to generation with zero new sources/cases. Existing independent evidence is retained. Generation and expert requests receive the accumulated usable data without rejected candidates; rejection never creates a dataset or approval. Other phases cannot use this new outcome to bypass their existing contracts. The ledger commits rejection before acquisition's phase CAS, so a restart in between replays the diagnostics with zero GETs and can finish that CAS. Review/permission/factual gates remain unchanged.

Only locally classified definitive retrieval/schema/safety failures enter this path. Network failures, provider errors/warnings, storage errors, lost acknowledgements, unexpected exceptions and already-pending/ambiguous claims do not authorize fallback or re-dispatch. A committed rejection whose acknowledgement was lost is observable on the next claim; an uncommitted rejection remains pending. A cached success newly failing current safety policy is blocked rather than overwritten as a different terminal result. Historic pending claims, including the recorded live probe, cannot be retroactively classified without operator reconciliation; this code does not mutate them.

## Integration handoff

```ts
import { acquireEvaluationData } from '../evals/data/acquisition';
import { createMediaWikiDiscovery } from '../evals/data/discovery';

const { discover } = createMediaWikiDiscovery({
  providerOrigin: 'https://en.wikipedia.org',
  queries: ['operator selected public topic'],
  operations: discoveryOperationStore,
  userAgent: 'YourApplication/1.0 (https://your-public-contact.example/info)',
  maxResults: 5,
  maxContentChars: 80_000,
  knownSecrets,
});
const task = await acquireEvaluationData(spec, { sources: [], cases: [] }, {
  store: evaluationDataStore, discover, generate, expert, knownSecrets,
  // reviewCandidates: separately authenticated independent review, if provisioned.
});
```

`discoveryOperationStore`, `evaluationDataStore`, `generate`, `expert`, `spec` and `knownSecrets` above are application dependencies, not supplied globals. The example contact domain must be replaced with the operator's truthful public application website. `createMediaWikiDiscovery(MediaWikiDiscoveryConfig)` returns `Pick<EvaluationDataPorts, 'discover'>`. `operations` is required; `transport?: PublicSourceTransport` and `now?: () => Date` permit deterministic fixtures. `PublicSourceTransport.get(endpoint)` returns parsed unknown JSON. Production should use the default `HttpsPublicSourceTransport`; an arbitrary injected implementation does not inherit its network protections.

There are one to three configured queries, each nonblank and at most 256 characters; at most five unique results and 80,000 aggregate content characters. `maxResults` and `maxContentChars` accept smaller positive integers. One operation makes at most three search GETs plus one batched revision GET. It stops when the result cap is met and never requests continuation. The default adapter transport bounds request path/query to 4,096 UTF-8 bytes, response to 256,000 bytes per request, and the DNS/socket deadline to 30 seconds per request. Excess content is rejected rather than silently truncated. Empty search results complete with an empty batch. Definitive schema, source or safety rejection is persisted as a separate terminal rejection before it is returned. Provider error/warning responses and transport failures remain pending because they do not establish a definitive unusable response.

`userAgent` defaults to `StandardEvals-PublicDiscovery/1.0`; operators can set a public contact website. It is at most 256 printable ASCII characters, screened with origin/queries for secrets and PII, and included in the operation fingerprint. Queries and known secrets are copied at construction. Reconstruct the adapter when the current known-secret policy changes so cached results receive the new screen. Known secrets are screening policy and do not authorize key reuse with changed search scope.

Wire the returned `discover` function directly into `acquireEvaluationData` alongside the existing durable evaluation task store, bounded generation adapter and expert adapter. Start with an empty initial batch unless an authenticated adapter supplied evidence. Keep candidate review as a separate authenticated port. Never copy discovery output into an approved registry automatically or add an automatic review callback. Acquisition itself strips discovery answer approval claims and forces pending source reviews; quality admission still blocks these candidates until the independent process approves them.

The parent application must provision durable operation storage and evaluation task storage, authorized queries/origin, provider contact identity, current known secrets, independent source/license review, candidate-case generation, expert intake and the final mapping/persistence handoff described in [data adapters](track-b-data-adapters.md). Discovery does not change Track A app/contracts, manifests, orchestration routes, expert authorization, or suite admission.

## Validation and limitations

Use the selected strict harness for both affected components:

```sh
node tests/track-b/run-checks.mjs --components evals,targets --track-a-ref origin/track-a
```

All provider responses in tests are authored fixtures delivered through injected transports or mocked HTTPS. They are not fetched public sources or independent verification of facts or licenses. No live provider validation, cloud mutation, spending, outreach, push or PR is part of this implementation. Production operation-store atomicity, provider availability, actual search relevance and factual or legal review remain explicit integration responsibilities.

Historical adapter validation (before terminal rejection support): `node tests/track-b/run-checks.mjs --components evals,targets --track-a-ref 516e5744211f3c4b17cee4d7b4338a6cf129e44b` passed strict TypeScript compilation and 437 tests across 27 files, none skipped. This includes 24 discovery fixtures, 48 GET transport tests, all existing POST transport tests and existing local TLS tests. GET socket behavior is mocked; the existing real local TLS tests exercise the unchanged POST transport. Existing offline harness dependencies were reused through a temporary symlink, removed after validation. No manifest, lockfile or dependency changes were made. The full Track B/app harness and live MediaWiki searches were not run.

Terminal rejection validation: `node tests/track-b/run-checks.mjs --components evals --track-a-ref origin/track-a` resolved local contracts at `f28b7a63ec78bbacd5ab7633ccf818a119c99401` and passed strict TypeScript plus 358 tests in 23 files, none skipped. Coverage includes file-backed SQL restart before acquisition phase persistence, immutable terminal-result races, scope/token checks, lost acknowledgements versus uncommitted writes, zero-GET rejection replay, unsafe-source fallback and unchanged reviewed-candidate gates. Existing local dependencies were reused without installation; no live/network/provider/cloud calls were run.
