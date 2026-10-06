# OpenCode provider quota recovery

Status: implemented in PR #13 on `develop`  
Goal: normalize recoverable OpenCode provider failures into Paperclip's existing recovery contract and make provider quota retry creation idempotent.

## 1. Decision

Paperclip already has the primitives needed to represent provider waits:

- `heartbeat_runs.status = scheduled_retry`
- `scheduledRetryAt`
- `scheduledRetryAttempt`
- `scheduledRetryReason`
- promotion of due scheduled retries back to `queued`
- provider quota recovery with a default backoff
- run-level retry UI
- OpenCode session persistence

The implementation therefore does not add a new agent-level waiting status, scheduler, or database migration.

The intended flow is:

```text
OpenCode provider failure
        |
        v
adapter classifies the failure
        |
        +--> deterministic failure -> existing failure path
        |
        +--> transient_upstream -> existing transient recovery behavior
        |
        v
provider_quota + optional retryNotBefore
        |
        v
provider_quota_recovery scheduled_retry
        |
        +--> agent remains idle / healthy
        |
        v
retry becomes eligible when due
```

## 2. OpenCode adapter contract

The OpenCode adapter preserves terminal provider errors separately from tool failures and classifies only evidence relevant to the model provider.

Recoverable classifications use the canonical result shape:

```json
{
  "errorFamily": "provider_quota",
  "retryNotBefore": "2030-04-22T21:30:00.000Z"
}
```

`retryNotBefore` is nullable when the provider supplies no trustworthy reset or retry hint.

The adapter does not emit a legacy `providerQuotaRetryNotBefore` compatibility alias as its normalized result contract.

### Provider quota

Strong usage, session, billing, or quota exhaustion evidence is classified as `provider_quota`.

Examples include:

- quota reached or exceeded
- usage/session/weekly/monthly/daily limit reached
- credits exhausted
- billing or spending limit reached

A generic HTTP 429 alone is not enough to call the failure a hard quota exhaustion.

### Transient upstream pressure

Short-lived provider pressure is classified as `transient_upstream`.

Examples include:

- HTTP 429 without hard-quota evidence
- HTTP 5xx provider failures
- `RESOURCE_EXHAUSTED`
- overloaded/capacity failures
- temporary unavailability
- explicit short retry hints

### Deterministic failures

The adapter deliberately keeps deterministic failures out of provider retry recovery.

Examples include:

- invalid or missing API key
- unauthorized/forbidden
- model not found or unsupported
- invalid tool schema
- context length overflow

Tool execution failures remain a separate failure domain and are not reclassified as model-provider failures just because tool output contains generic HTTP status text.

## 3. Retry timing

The adapter only emits `retryNotBefore` when it can derive a trustworthy future time.

Supported sources include:

- absolute reset timestamps
- structured retry-delay values
- numeric `Retry-After` seconds
- HTTP-date `Retry-After`
- recognized unit-bearing retry values such as seconds, minutes, hours, and milliseconds
- recognized prose such as `try again after 30 minutes`

Unit-bearing `Retry-After` values are parsed as durations before bare numeric-seconds matching. Unsupported units are not truncated to a numeric prefix.

For example:

- `Retry-After: 30 minutes` means 30 minutes
- `Retry-After: 30 ms` means 30 milliseconds
- `Retry-After: 30 fortnights` does not produce a retry time

If no valid hint exists, the recovery layer uses its existing provider-quota fallback timing.

## 4. Recovery behavior

Provider quota recovery reuses the durable `scheduled_retry` path.

The recovery identity is scoped to:

- the issue
- the recovery reason `provider_quota_recovery`
- the source run when one exists

The recovery transaction locks the issue and then the source run, matching the existing issue-then-run lock order used by retry scheduling.

Before creating a new retry, recovery looks for an existing logical retry in `scheduled_retry`, `queued`, or `running` state. Repeated or concurrent recovery attempts reuse that run instead of creating duplicates.

The wakeup idempotency key is stable for the logical recovery attempt and does not depend on a newly computed timestamp.

No uniqueness migration is added. Correctness is provided by the transaction and locking boundary together with the existing unique recovery-action constraints.

## 5. Session and error metadata

Recoverable OpenCode failures preserve useful session metadata so a later retry can continue the same work where safe.

Surfaced provider failure messages are bounded before being written into run metadata.

The source failed run remains inspectable while the current execution path can wait through the existing scheduled-retry mechanism.

## 6. Verification coverage

The implementation includes focused coverage for:

- hard quota exhaustion with and without a reset time
- generic HTTP 429 handling
- `RESOURCE_EXHAUSTED` with retry metadata
- temporary 5xx/capacity failures
- deterministic auth/model/tool-schema/context failures as negative controls
- clean-exit provider failures with no assistant output
- structured JSON embedded in provider output
- textual `Retry-After` seconds and HTTP dates
- unit-bearing `Retry-After` values
- malformed or unsupported retry units
- unrelated scheduled retries not suppressing quota recovery
- repeated recovery reusing one logical retry
- concurrent recovery producing one quota retry and one wakeup

## 7. Out of scope

This change intentionally does not add:

- automatic fallback to another provider/model
- provider priority chains
- a global provider circuit breaker
- a global OpenCode concurrency bucket
- a new `waiting` agent status
- new task lifecycle semantics
- Ollama integration

Those can reuse the same normalized provider-failure signals later if needed.

## 8. Risks

### False-positive provider classification

Overly broad text matching could delay work that should fail immediately.

Mitigation: prefer structured evidence, use conservative patterns, keep deterministic failures excluded, and maintain negative controls.

### Incorrect retry timing

A parser that accepts a numeric prefix from a unit-bearing value can schedule too early.

Mitigation: parse recognized durations explicitly and reject unsupported unit suffixes instead of falling back to bare seconds.

### Duplicate recovery under concurrency

Two recovery attempts could otherwise create duplicate wakeups or scheduled retries.

Mitigation: serialize on issue/source-run row locks and reuse an existing logical recovery run inside the same transaction.

## 9. Final architecture

The implementation keeps the responsibility split intentionally:

- OpenCode adapter: identify and normalize provider failures
- recovery service: decide durable provider-quota retry timing and create/reuse the retry
- heartbeat scheduler: promote due retries
- UI: render the existing run-level scheduled retry state

This keeps provider-specific parsing at the adapter boundary while preserving Paperclip's existing recovery state machine.
