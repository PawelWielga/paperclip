# OpenCode provider quota recovery plan

Status: planning only, no production code changes yet  
Branch: `feature/provider-waiting-state`  
Goal: make OpenCode-backed agents wait cleanly for provider quota reset and resume automatically without leaving the agent in an error state.

## 1. Key finding

Paperclip already contains most of the desired behavior.

Existing primitives:

- `heartbeat_runs.status = scheduled_retry`
- `scheduled_retry_at`
- `scheduled_retry_attempt`
- `scheduled_retry_reason`
- durable promotion of due scheduled retries back to `queued`
- provider quota classification in recovery
- provider quota reset-time parsing and a default one-hour fallback
- UI support for scheduled retries
- session persistence across heartbeats
- tests proving quota failures can leave the agent in `idle` with `errorReason = null`

Because these mechanisms already exist, introducing a new global agent status such as
`waiting_for_provider` would duplicate the run-level state machine and create unnecessary
schema, API, UI, filtering, attention, and migration work.

The preferred design is therefore:

```
OpenCode provider quota failure
        |
        v
run classified as provider_quota
        |
        v
scheduled_retry(retryAt)
        |
        +--> agent remains idle / healthy
        |
        v
retry is promoted when due
        |
        v
same task/session continues
```

## 2. Problem to solve

The missing or uncertain part is the OpenCode adapter boundary.

We need to verify that quota and rate-limit failures from providers used through
`opencode_local` are consistently converted into Paperclip recovery metadata.

Examples include:

- HTTP 429 / Too Many Requests
- `quota exceeded`
- `usage limit reached`
- `rate limit exceeded`
- `model at capacity`
- provider messages containing an explicit reset or retry time
- provider responses exposing `Retry-After` or equivalent structured metadata through OpenCode

The fix should not treat authentication errors, invalid model configuration, malformed tool
definitions, context overflows, or normal model failures as quota exhaustion.

## 3. Existing architecture to reuse

### Database

`packages/db/src/schema/heartbeat_runs.ts`

Already provides:

- `retryOfRunId`
- `scheduledRetryAt`
- `scheduledRetryAttempt`
- `scheduledRetryReason`

No database migration is expected for the preferred solution.

### Shared contracts

`packages/shared/src/constants.ts`

Already defines:

- heartbeat run status `scheduled_retry`
- agent statuses without a provider-wait state

No new `AgentStatus` is planned.

### OpenCode adapter

Primary area:

- `packages/adapters/opencode-local/src/server/execute.ts`
- `packages/adapters/opencode-local/src/server/parse.ts`
- `packages/adapters/opencode-local/src/server/execute.test.ts`

The adapter already persists OpenCode sessions and has recovery behavior for some
OpenCode-specific failures.

This is the first place to inspect and, if necessary, normalize quota failures.

### Recovery

Primary area:

- `server/src/services/recovery/service.ts`
- `server/src/services/recovery/provider-failure-classification.test.ts`

Paperclip already has:

- `provider_quota` failure classification
- reset-time parsing
- `PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS`
- durable provider quota recovery monitor scheduling

This should remain the source of truth for when a provider may be retried.

### Heartbeat scheduler

Primary area:

- heartbeat retry scheduling implementation
- `server/src/modules/run-dispatch/adapters/postgres.ts`
- `server/src/__tests__/heartbeat-retry-scheduling.test.ts`

Existing tests already demonstrate that a provider quota failure may create a
`scheduled_retry` while the agent returns to:

```ts
{ status: "idle", errorReason: null }
```

This is exactly the dashboard behavior we want.

### UI

Relevant areas:

- `ui/src/lib/runRetryState.ts`
- issue scheduled-retry components
- agent status components

The run-level UI already renders `scheduled_retry` as a neutral/informational retry state.

We should only add OpenCode/provider-specific wording if the generic UI is unclear.
No new agent-status color is planned.

## 4. Proposed behavior

### Quota with known reset time

Example:

```
Provider: quota exhausted
Retry after: 2026-10-07T00:00:00Z
```

Expected:

1. current run terminates with normalized `errorCode = provider_quota`
2. normalized recovery metadata contains `providerQuotaRetryNotBefore`
3. Paperclip creates a durable `scheduled_retry`
4. agent returns to `idle`, not `error`
5. no automatic heartbeat bypasses the quota window for that work
6. at reset time the scheduled run becomes eligible
7. OpenCode resumes the previous session where safe

### Quota with no reset time

Expected:

1. classify as `provider_quota`
2. use the existing Paperclip default backoff
3. schedule a durable retry
4. keep the agent healthy/idle

### Non-quota provider failure

Do not classify as quota solely because the provider returned a non-zero exit code.

Existing transient infrastructure retry policy remains responsible for unrelated temporary
errors.

### Permanent configuration failure

Examples:

- invalid API key
- missing credentials
- model does not exist
- unsupported provider/model configuration

Expected:

- no quota wait
- surface as configuration error/blocker through existing behavior

## 5. Implementation phases

### Phase A - Reproduction first

Before changing code, create focused tests for `opencode_local` covering representative
OpenCode output for:

1. HTTP 429 / rate-limit response
2. quota-exceeded text response
3. usage-limit response with a reset time
4. quota response without reset time
5. authentication failure as a negative control
6. model-not-found as a negative control

The tests must fail before implementation where the current behavior is incomplete.

### Phase B - Normalize OpenCode quota failures

Add the smallest possible normalization layer in the OpenCode adapter/parser.

Preferred normalized result:

```json
{
  "errorFamily": "provider_quota",
  "providerQuotaRetryNotBefore": "<ISO timestamp when known>"
}
```

and/or the existing adapter execution contract's equivalent structured fields.

Do not add provider-specific scheduling logic to the OpenCode adapter. The adapter should
only identify and normalize the failure.

### Phase C - Connect to existing recovery path

Verify that normalized OpenCode output reaches the existing:

- `provider_quota` classification
- `scheduled_retry` creation
- retry-at parsing
- agent idle cleanup

Only change recovery code if an OpenCode-normalized failure cannot currently reach this path.

### Phase D - End-to-end regression test

Add a test covering:

```
opencode_local quota failure
 -> failed source run classified as provider_quota
 -> durable scheduled_retry
 -> agent idle/errorReason null
 -> due retry promoted
 -> resumed execution
```

Where feasible, verify session continuity metadata as well.

### Phase E - UI verification

Confirm:

- agent card does not become red for a recoverable quota wait
- issue/run shows a scheduled retry and retry time
- historical source run may remain failed, but the current execution path is clearly waiting
- no attention/error card incorrectly treats the agent as broken

Prefer no UI changes unless a real usability gap is found.

### Phase F - Upstream PR preparation

Before PR:

- search current upstream issues/PRs again
- reference related quota/retry issues
- keep the PR scoped to OpenCode quota normalization and existing scheduled-retry behavior
- avoid proposing a new agent lifecycle state

Suggested PR title:

`fix(opencode-local): route provider quota failures through scheduled retry recovery`

## 6. Testing checklist

Required targeted tests:

- OpenCode parser / execute tests
- provider failure classification tests
- heartbeat retry scheduling tests
- agent status remains healthy during quota wait
- retry time is honored
- duplicate recovery attempts do not create multiple scheduled retries
- restart persistence of scheduled retry
- negative tests for auth/configuration errors

Then run repository-required validation from `AGENTS.md` / contributing instructions.

## 7. Out of scope for this PR

These are separate follow-ups:

- automatic fallback from one provider/model to another
- provider priority chains
- global provider circuit breaker shared by multiple agents
- global OpenCode concurrency bucket
- adding a new `waiting` AgentStatus
- changing task lifecycle semantics
- Ollama integration

A later fallback design can reuse the same `provider_quota` signal.

## 8. Risks

### False positive quota classification

A broad regex could park an agent for hours on an unrelated error.

Mitigation: prefer structured OpenCode/provider metadata, use conservative text patterns,
and add negative tests.

### Retry storms

A quota wait must gate repeated automatic execution until `retryAt`.

Mitigation: reuse durable `scheduled_retry` and verify other wake paths do not bypass it.

### Lost session continuity

A retry should preserve the OpenCode session when the failure is transient and the session
remains valid.

Mitigation: assert session metadata in integration coverage.

### Upstream overlap

Paperclip has active work and issues around provider quota recovery.

Mitigation: rebase from upstream immediately before implementation and again before PR,
then narrow the patch to the OpenCode-specific gap that still exists.

## 9. Decision

Do **not** implement a new agent-level `waiting_for_provider` state at this stage.

First prove and close the OpenCode-to-existing-provider-quota-recovery gap.

If testing demonstrates that Paperclip's existing `scheduled_retry` path cannot represent
the desired dashboard state, revisit the agent-state proposal with concrete evidence.
