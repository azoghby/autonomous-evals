# Standard Evals regression check (GitHub Action)

Re-runs the frozen eval suite from a delivered Standard Evals job against your agent endpoint on every pull request, writes a results table to the job summary, and fails the step when scenarios fail.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `api-key` | yes | Your Standard Evals API key. Store it as a repository secret. |
| `job-id` | yes | The delivered job whose frozen suite is re-run. You must own the job. |
| `target-url` | no | HTTPS endpoint to test. Defaults to the job's original endpoint. Must be a public host. |
| `target-authorization` | no | Your endpoint's API key. Sent as `X-Target-Authorization`; never stored or logged, and masked in runner logs. |
| `model` | no | Model name to request. Defaults to the job's original model. |
| `fail-on` | no | `any` (default) fails on any failing scenario. `regressions` fails only when a scenario tied to a verified fix fails again. |
| `api-base-url` | no | Override for preview or self-hosted deployments. |
| `timeout-seconds` | no | Polling limit for long runs (default 600). |

Outputs: `passed`, `total`, `failed`.

## Example workflow

```yaml
name: agent-regression
on:
  pull_request:
  push:
    branches: [main]

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: your-org/autonomous-evals/integrations/github-action@main
        with:
          api-key: ${{ secrets.STANDARD_EVALS_API_KEY }}
          job-id: 00000000-0000-4000-8000-000000000000
          target-url: https://staging.example.com/v1/chat/completions
          target-authorization: ${{ secrets.STAGING_AGENT_KEY }}
          fail-on: regressions
```

## API

`POST /api/v1/regression-runs` with `Authorization: Bearer <api key>`, body `{ "jobId", "targetUrl?", "model?" }`, optional header `X-Target-Authorization`. Returns `200` with `{ runId, status: "completed", passed, total, failed: [{ scenarioId, title, detail }], previouslyFixedRegressed: [...] }`, or `202 { runId, status: "running" }` when the run exceeds about 50 seconds; poll `GET /api/v1/regression-runs/{runId}`.

Runs are rate limited (20 per 10 minutes per key) and capped at the monitoring per-run budget.
