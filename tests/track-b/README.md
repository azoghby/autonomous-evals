# Track B acceptance fixtures

`trace-acceptance.json` is an independent, synthetic behavioral corpus for the Trace Audit integration. It includes positive findings and negative controls: successful actions, successful retries, honest failures, quoted customer claims, incomplete evidence, instruction violations, and malicious instructions embedded in logs.

The corpus is not yet connected to an executable engine test. Once engine services are integrated, the acceptance adapter must normalize these transcripts to the supported input shape and assert their semantic expectations. Do not treat exact model prose as stable. Preserve tool-call IDs and distinguish the assistant's claims from quoted user content.

For a finding, verify its evidence exists in the input and that its classification follows the evidence. Missing tool results can justify flagging unsupported success but cannot prove the external action failed. A tool error followed by a verified successful retry must not become a false failure.

Run deterministic checks with injected judge responses separately from real-provider acceptance. A mocked investigator does not prove the Naïve path works. Live acceptance should record model/agent versions, sessions, spend, and observed outcomes without exposing credentials or storing sensitive provider output.

Never count these fixtures as independent customers, live revenue, or external validation.
