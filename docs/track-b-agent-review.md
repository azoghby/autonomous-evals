# Track B agent review (independent)

Scope: `agents/session-service.ts`, `agents/naive-adapter.ts`, `agents/redact.ts`, `agents/operator.ts`, `evals/trace/**`, `evals/service-adapter.ts`, `reporting/**`. Not reviewed: targets, simulator, Neon, absent Postgres/Text Eval code. No live calls were made. The one live-evidence input is the sanitized 2026-11-07 run state in `/tmp/trackb-live/state.json`, read locally (fixture trace only).

Baseline: `npm --prefix tests/track-b run check -- --track-a-ref origin/track-a` is green (22 files, 333 tests, strict tsc). No production file was changed.

Reproducers: `node tests/track-b/agent-review/run.mjs` (after `npm ci --prefix tests/track-b --workspaces=false`; stages the sources plus Track A contracts from `origin/track-a`, strict tsc, then vitest). 28 tests, all passing today. Convention as for `KNOWN GAP`: a `DEFECT` test asserts the current wrong behavior and **fails once fixed**; flip it then. `RISK`/`LIMITATION`/`FINDING` tests pin non-defects or representation facts.

What held up (checked, no defect found): the ambiguous-create state machine (same key, same stored body, lookup before replay, lease expiry, duplicate-session escalation, 429 not counting as replay), reserve-before-send and settle-after-record ordering, citation verification (exact, whitespace-insensitive, fabricated quotes cannot become `confirmed`), the report renderer (Markdown/HTML escaping, no revenue/profit), and the 4xx path (settled to 0).

## Defects (open)

Severity is my judgment of customer/ops impact.

### D1. Credential redaction misses common forms (high)
`agents/redact.ts:22-37` (patterns), applied in `evals/trace/normalize.ts:322`.
- Trigger: any trace/tool output with `DB_PASSWORD=…`, `AWS_SECRET_ACCESS_KEY=<40 chars>`, `STRIPE_SECRET=…`, `OPENAI_API_KEY=<non sk- value>`, `authToken=…`, JSON `{"token":"…"}`, `mysql://u:pw@host`, or a multi-word password (`"password":"correct horse battery staple"` becomes `[REDACTED] horse battery staple`).
- Cause: `key_value_secret` starts with `\b`, which cannot match inside `DB_PASSWORD` (underscore is a word character); a bare `token` key and `secret` followed by `_` are not covered; the value class stops at whitespace; only `postgres://` URLs are handled.
- Impact: the secret goes into the investigator prompt (Naïve request body) and into customer report evidence. `containsSecret` uses the same list, so the session service's refusal gate cannot catch it either (test D1c shows it end to end).
- Fix: key match without the leading `\b` (e.g. `(?:^|[^A-Za-z0-9])[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*`), take the whole quoted string for quoted values, generic `scheme://user:pass@` URLs, and add `hf_`, `SG.`, `npm_`, `napi_`, `glpat-`, 40-char AWS secret after `aws_secret`. Pattern redaction stays a net; keep `knownSecrets`.

### D2. Known secrets with JSON-special characters survive JSON traces (medium)
`evals/trace/audit.ts:303` (and `agents/session-service.ts:158`).
- Trigger: caller passes `knownSecrets: ['pa"ss\\word…']`; the trace is JSON, where the secret is stored escaped.
- Cause: `split()` runs on the raw JSON text. After decoding, `normalizeTrace` redacts by pattern only. The session service's known-secret gate compares the decoded secret with the JSON-escaped prompt.
- Impact: secret in prompt and in evidence. Today `auditTrace` callers pass no known secrets (the adapter does not), so this is latent until Track A supplies them.
- Fix: pass `known` into `normalizeTrace` and redact each decoded event text (and also the system prompt, already done); gate on both the plain and `JSON.stringify` forms.

### D3. Events are clipped before redaction (low)
`evals/trace/normalize.ts:320-322` (same pattern in `service-adapter.ts:137` `intake.trace.slice(0, 1_500)` before `sanitizeIntake`).
- Trigger: a key crosses the 20,000-character cut. `sk-ant-` + 15 chars is below the 16-char minimum, so ~10 characters of the key survive.
- Fix: redact, then clip.

### D4. A stored task result is reused for a different request (medium)
`agents/session-service.ts:157-158` and `resume` (`:247`).
- Trigger: same `job/role/purpose/attempt` with a different `message`/schema/budget: e.g. redeploy mid-job with changed detector or prompt code, or the same job id audited twice.
- Impact: the old session's output is returned as if it answered the new request. In Trace Audit the verdicts are matched by positional ids (`K1…`, `audit.ts:214`) and a `confirmed` with empty `evidence` needs no citation check, so a stale `confirmed` is attached to whatever candidate now has that id (test D4b: a benign heuristic is labeled `confirmed` with a rationale written for another trace). Resume itself is desired; applying it to different input is not.
- Fix: store a digest of the request (`sha256` of `message`+schema name) in the row/metadata; on resume with a different digest return `needs_operator` (`task_input_changed`) unless the attempt is bumped. In Trace Audit, also drop verdicts whose candidate title/evidence differ from the current candidate (carry a candidate digest in the prompt and require it in the verdict).

### D5. Spend is lost from `ctx.recordCost` on non-completed outcomes (medium)
`evals/service-adapter.ts:161-179` (`throwForNonCompleted`), `:185`, `:195-196`, `:224-228`.
- Trigger: investigator session ends `budget_paused` or `awaiting_*`, or `qualify` returns `schema_failed`/`failed`/`budget_paused`.
- Impact: the ledger settled the measured spend (`session-service.ts:416`) but the Workflow never records it, and the step then fails fatally, so no retry will. Console "known costs" under-reports exactly the sessions that blew budget (tests D5, D5b). Also the thrown message is `"schema_failed: "`: the validation issues are discarded.
- Fix: record `outcome.cost` (or `costs[]`) before throwing, and include `issues`/`code` in the error. Dedupe is already by `naive:<sessionId>`.

### D6. `"error": null` / `"failed": 0` read as error wording (medium, precision)
`evals/trace/normalize.ts:70` and `:326-331`.
- Trigger: tool success such as `{"status":"created","error":null}` or `{"sent":12,"failed":0}` with no `ok:true`.
- Impact: `errorSignal: "pattern"` creates an `unsupported_claim` ("result with error wording", heuristic) and an `ignored_error` for correct runs. These stay heuristic and are sent to the investigator, so a good investigator dismisses them; but with the investigator unavailable they are listed to customers as inconclusive findings.
- Fix: test `ERROR_WORDS` against string values only, or parse JSON and use only values, not keys; treat falsy `error`/`failed`/`errors` as success.

### D7. Relevance uses tool-call arguments (medium, precision with objective label)
`evals/trace/detect.ts:152-157`.
- Trigger: successful `send_email`, then an unrelated failing call whose args mention the topic (`log_analytics {"event":"email sent"}`). The later call wins as "latest relevant".
- Impact: an objective, high-severity "Success claimed after log_analytics reported failure" for a claim the log supports. The prompt then pushes the investigator to defend an objective check (a dismissal needs a defect note), so false positives are more likely to end as `inconclusive`/`confirmed`.
- Fix: match topics on tool name only (plus result text when there is no call); or require the failing action to be the same tool/call id as the supporting one before declaring `contradicted`.

### D8. A required phrase in a rule sentence is a "prohibited term" (low-medium)
`evals/trace/detect.ts:354-370`.
- Trigger: `Never discuss pricing; always say 'contact sales'.` The rule regex only splits on `.!?\n`, so the quoted `contact sales` becomes a protected term and the compliant reply is reported as `Assistant output contains a term the instructions prohibit`.
- Fix: split rules on `;` and "always/must/should say", or take protected terms only from the clause after the prohibition word.

### D9. Operator summary and notes can say "confirmed" for non-confirmed findings (medium)
`agents/operator.ts:53-57`.
- Trigger: any agent output; the policy checks only unknown ids, prices and profit/revenue/significance/guarantee words (test D9). The report shows the agent text as the Summary and as "Operator note" beside a finding labeled Inconclusive, with a counts table of 0 confirmed.
- Fix: reject (or replace with the code summary) text containing "confirmed" when no finding is confirmed, and per-note when the referenced finding is not `confirmed`; ideally render counts from code and keep agent text to next steps.

### F1. Live evidence: investigator quotes for JSON events (representation, not a verification defect)
`evals/trace/audit.ts:137-199` (`safeJson`, event `text` as JSON strings).
Observation from `ses_6gknx1k95w0qzk3ns9b45n9kf4`: the two events whose text is JSON (`e2`, `e3`) got fabricated quotes (`Request Body:{tooltipBody}}`); the plain sentence (`e4`) was quoted correctly. Verification worked as designed and the `confirmed` verdict was correctly withheld.
What the code shows (tests F1/F1b): the prompt gives each event as a JSON string inside JSON, so `e3` appears as `{\"ok\":false,\"error\":\"dependency unavailable\"}`; a literal copy of what the model sees can never verify, a plain sentence can; `<` appears as `<`, same problem. A model that decodes the JSON string correctly does verify, so this is a fragility and a plausible contributor, **not a proven cause** of the fabricated text (n=1, one model; the placeholder-looking output may be a decoding artifact of structured output with brace-heavy strings). The candidate's own `evidence` quotes (code-found, already exact) were in the prompt too.
Suggested changes that keep exact verification and need no automatic retry:
1. Present each event as a delimited plain-text block (`[e3 tool_result create_event error=explicit]` newline raw text newline `[/e3]`), not a JSON-escaped string, and escape only the closing `</untrusted_data>` sequence by inserting a zero-width marker the verifier strips from the *prompt copy only* (or put the boundary in a random nonce tag).
2. Instruct: "quote the shortest distinctive fragment (≤ 80 chars), prefer words without quotes, braces or backslashes (`dependency unavailable`)". Shorter plain fragments verify under the existing whitespace-insensitive check.
3. Let the investigator reference code-found evidence by id (`candidate_evidence: [0,1,2]`) instead of re-quoting it; keep the quote path, still exact, for `additional_findings`. This removes the need to copy JSON for the common case.
Re-run the live check afterward on a JSON-event fixture: acceptance is a `confirmed` label on the live false-success case with all citations verified. That acceptance is still open.

## Risks / limitations (not defects)

- R1 (`session-service.ts:283`, `:350`): a 409 `idempotency_conflict` (in flight) uses a replay. Three quick retries with 5 s back-off can reach `needs_operator (ambiguous_create_unresolved)` while the original request is still being processed. Whether the live API holds a request longer than ~15 s after our 30 s client timeout is unproven. Consider not counting `in_flight` as a replay but bounding it by wall-clock.
- R2 (`session-service.ts:375`): any error from `getSession` (including a definitive 401/404) returns `pending/naive_unreachable` forever; the reservation stays open at full size and no operator state is set. Escalate definitive errors after N attempts.
- L1 (`detect.ts:152`): a claim with no topic words ("Done!") is supported by any successful tool in the turn: false negatives.
- Pattern claim detection, scan window of 250 sessions in recovery (a miss falls back to a same-key replay, which is safe), and a compromised investigator that cites any verified quote for any candidate remain as documented in `docs/track-b-agents.md`.
