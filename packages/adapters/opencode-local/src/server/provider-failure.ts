import type { OpenCodeTerminalError } from "./parse.js";

type RecoverableProviderFamily = "provider_quota" | "transient_upstream";

export interface OpenCodeProviderFailureClassification {
  errorFamily: RecoverableProviderFamily;
  retryNotBefore: string | null;
}

export interface OpenCodeProviderFailureInput {
  terminalErrors: OpenCodeTerminalError[];
  stderr?: string | null;
  errorMessage?: string | null;
  toolErrors?: string[];
  exitCode?: number | null;
  hasOutput?: boolean;
}

type EvidenceFacts = {
  text: string[];
  codes: string[];
  statusCodes: number[];
  absoluteRetryHints: unknown[];
  retryDelayHints: unknown[];
  retryAfterHints: unknown[];
};

const HARD_QUOTA_RE =
  /(?:insufficient[_\s-]?quota|billing(?:\s+hard)?\s+limit|out\s+of\s+(?:credits?|quota)|credits?\s+(?:exhausted|depleted)|exceeded\s+your\s+current\s+quota|(?:usage|session|weekly|monthly|daily)\s+(?:limit|cap)\s+(?:reached|exceeded|exhausted)|you(?:'|’)ve\s+hit\s+your\s+(?:(?:usage|session|weekly|monthly|daily)\s+)?(?:limit|cap)|plan\s+(?:limit|quota)\s+(?:reached|exceeded)|spending\s+limit\s+(?:reached|exceeded))/i;

const TRANSIENT_TEXT_RE =
  /(?:rate[-_\s]?limit(?:ed|ing)?|too\s+many\s+requests|resource[_\s-]?exhausted|server\s+overloaded|overloaded_error|temporarily\s+unavailable|service\s+unavailable|bad\s+gateway|gateway\s+time-?out|internal\s+server\s+error|high\s+demand|throttl(?:ed|ing)|\bat\s+capacity\b|capacity\s+(?:is\s+)?(?:temporarily\s+)?(?:full|unavailable|exhausted))/i;

const DETERMINISTIC_FAILURE_RE =
  /(?:invalid[_\s-]+(?:api[_\s-]+)?key|missing[_\s-]+(?:api[_\s-]+)?key|authentication[_\s-]+(?:failed|required)|unauthori[sz]ed|forbidden|model[_\s-]?(?:not[_\s-]?found|does\s+not\s+exist|unknown|unsupported)|unknown[_\s-]?model|invalid[_\s-]+tool(?:[_\s-]+(?:definition|schema))?|tool[_\s-]+(?:definition|schema).*(?:invalid|unsupported)|context[_\s-]?(?:length|window)[_\s-]?(?:exceeded|overflow)|maximum[_\s-]+context[_\s-]+length)/i;

const TRANSIENT_CODE_RE =
  /(?:resource[_\s-]?exhausted|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|overloaded|temporarily[_\s-]?unavailable|service[_\s-]?unavailable|unavailable)/i;

const TRANSIENT_STATUS_TEXT_RE =
  /(?:\bhttp(?:\s+status)?\s*[:=#-]?\s*(?:429|5\d{2})\b|\bstatus(?:[_\s-]?code)?\s*[:=#-]\s*(?:429|5\d{2})\b)/i;

const PROSE_ABSOLUTE_RETRY_RE =
  /(?:try\s+again\s+at|retry(?:\s+at|\s+after)?|limit\s+will\s+reset\s+at|resets?\s+at)\s+["']?((?:20\d{2}-\d{2}-\d{2})[T\s][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?(?:Z|[+-][0-2]\d:?\d{2}))/i;
const TEXT_RETRY_DELAY_RE =
  /retry[-_\s]?delay["'`\s:=]+["'`]?((?:\d+(?:\.\d+)?)\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?))\b/i;
const TEXT_RETRY_AFTER_DATE_RE =
  /retry[-_\s]?after["'`\s:=]+["'`]?([A-Z][a-z]{2},\s?[^"'\`\n]+?(?:GMT|UTC))/;
const TEXT_RETRY_AFTER_SECONDS_RE =
  /retry[-_\s]?after["'`\s:=]+["'`]?((?:\d+(?:\.\d+)?))(?![\d.])(?!\s*(?:gmt|utc)\b)/i;
const CLEAN_EXIT_PROVIDER_WRAPPER_RE = /\bAI_APICallError\b/i;

const ABSOLUTE_RETRY_KEYS = new Set([
  "retrynotbefore",
  "retryat",
  "resetat",
  "resetsat",
  "resettimestamp",
  "resettime",
]);
const RETRY_DELAY_KEYS = new Set(["retrydelay"]);
const RETRY_AFTER_KEYS = new Set(["retryafter"]);
const STATUS_CODE_KEYS = new Set(["statuscode", "httpstatus", "httpstatuscode"]);
const CODE_KEYS = new Set(["code", "status", "name", "type", "reason", "errorcode"]);

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asHttpStatus(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value.trim())
        ? Number.parseInt(value.trim(), 10)
        : null;
  return numeric !== null && numeric >= 400 && numeric <= 599 ? numeric : null;
}

function maybeParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 20_000) return null;
  if (
    !((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectEvidence(
  value: unknown,
  facts: EvidenceFacts,
  depth: number,
  seen: Set<object>,
) {
  if (depth > 8 || value == null) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    facts.text.push(trimmed);
    const nested = maybeParseJson(trimmed);
    if (nested !== null) {
      collectEvidence(nested, facts, depth + 1, seen);
    } else if (trimmed.includes("\n")) {
      for (const line of trimmed.split(/\r?\n/).slice(0, 100)) {
        const nestedLine = maybeParseJson(line);
        if (nestedLine !== null) collectEvidence(nestedLine, facts, depth + 1, seen);
      }
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) {
      collectEvidence(entry, facts, depth + 1, seen);
    }
    return;
  }

  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    const normalizedKey = normalizeKey(key);

    if (ABSOLUTE_RETRY_KEYS.has(normalizedKey)) {
      facts.absoluteRetryHints.push(entry);
    }
    if (RETRY_DELAY_KEYS.has(normalizedKey)) {
      facts.retryDelayHints.push(entry);
    }
    if (RETRY_AFTER_KEYS.has(normalizedKey)) {
      facts.retryAfterHints.push(entry);
    }

    if (STATUS_CODE_KEYS.has(normalizedKey)) {
      const status = asHttpStatus(entry);
      if (status !== null) facts.statusCodes.push(status);
    }

    if (CODE_KEYS.has(normalizedKey)) {
      const status = asHttpStatus(entry);
      if (status !== null) facts.statusCodes.push(status);
      if (typeof entry === "string" && entry.trim()) {
        facts.codes.push(entry.trim());
      }
    }

    collectEvidence(entry, facts, depth + 1, seen);
  }
}

function buildEvidence(input: OpenCodeProviderFailureInput): EvidenceFacts {
  const facts: EvidenceFacts = {
    text: [],
    codes: [],
    statusCodes: [],
    absoluteRetryHints: [],
    retryDelayHints: [],
    retryAfterHints: [],
  };
  const seen = new Set<object>();

  for (const terminalError of input.terminalErrors) {
    if (terminalError.message) facts.text.push(terminalError.message);
    collectEvidence(terminalError.payload, facts, 0, seen);
  }

  if (input.errorMessage?.trim()) facts.text.push(input.errorMessage.trim());
  if (input.stderr?.trim()) facts.text.push(input.stderr.trim());

  return facts;
}

function futureDateIso(value: unknown, now: Date): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) return null;
  return parsed.toISOString();
}

function durationToMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value * 1_000 : null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const seconds = Number(record.seconds ?? record.second ?? Number.NaN);
    const nanos = Number(record.nanos ?? record.nanoseconds ?? 0);
    if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(nanos) && nanos >= 0) {
      const ms = seconds * 1_000 + nanos / 1_000_000;
      return ms > 0 ? ms : null;
    }
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)$/i,
  );
  if (!match?.[1] || !match[2]) return null;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2].toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("millisecond")) return amount;
  if (unit.startsWith("h")) return amount * 60 * 60 * 1_000;
  if (unit.startsWith("m")) return amount * 60 * 1_000;
  return amount * 1_000;
}

function retryAfterToIso(value: unknown, now: Date): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(now.getTime() + value * 1_000).toISOString();
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    return seconds > 0
      ? new Date(now.getTime() + seconds * 1_000).toISOString()
      : null;
  }

  return futureDateIso(trimmed, now);
}

function proseRetryDelayMs(text: string): number | null {
  const match = text.match(
    /(?:try\s+again|retry)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i,
  );
  if (!match?.[1] || !match[2]) return null;
  return durationToMs(`${match[1]}${match[2]}`);
}

function resolveRetryNotBefore(
  facts: EvidenceFacts,
  evidenceText: string,
  now: Date,
): string | null {
  for (const hint of facts.absoluteRetryHints) {
    const parsed = futureDateIso(hint, now);
    if (parsed) return parsed;
  }

  for (const hint of facts.retryDelayHints) {
    const delayMs = durationToMs(hint);
    if (delayMs !== null) return new Date(now.getTime() + delayMs).toISOString();
  }

  for (const hint of facts.retryAfterHints) {
    const parsed = retryAfterToIso(hint, now);
    if (parsed) return parsed;
  }

  const textRetryDelay = evidenceText.match(TEXT_RETRY_DELAY_RE)?.[1];
  if (textRetryDelay) {
    const delayMs = durationToMs(textRetryDelay);
    if (delayMs !== null) return new Date(now.getTime() + delayMs).toISOString();
  }

  const textRetryAfterDate = evidenceText.match(TEXT_RETRY_AFTER_DATE_RE)?.[1];
  if (textRetryAfterDate) {
    const parsed = retryAfterToIso(textRetryAfterDate, now);
    if (parsed) return parsed;
  }

  const textRetryAfterSeconds = evidenceText.match(TEXT_RETRY_AFTER_SECONDS_RE)?.[1];
  if (textRetryAfterSeconds) {
    const parsed = retryAfterToIso(textRetryAfterSeconds, now);
    if (parsed) return parsed;
  }

  const proseAbsolute = evidenceText.match(PROSE_ABSOLUTE_RETRY_RE)?.[1];
  if (proseAbsolute) {
    const parsed = futureDateIso(proseAbsolute, now);
    if (parsed) return parsed;
  }

  const proseDelayMs = proseRetryDelayMs(evidenceText);
  return proseDelayMs !== null
    ? new Date(now.getTime() + proseDelayMs).toISOString()
    : null;
}

export function classifyOpenCodeProviderFailure(
  input: OpenCodeProviderFailureInput,
  now = new Date(),
): OpenCodeProviderFailureClassification | null {
  const exitCode = input.exitCode ?? 0;
  const hasStructuredTerminalFailure =
    input.terminalErrors.length > 0 || Boolean(input.errorMessage?.trim());

  // Productive clean runs are successes even if stderr contains a recovered
  // provider warning. We deliberately never scan stdout/user transcript text.
  if (exitCode === 0 && !hasStructuredTerminalFailure && input.hasOutput) {
    return null;
  }

  const facts = buildEvidence(input);
  const evidenceText = [...facts.text, ...facts.codes].join("\n");
  if (!evidenceText && facts.statusCodes.length === 0) return null;

  // Deterministic failures must never enter provider retry recovery.
  if (DETERMINISTIC_FAILURE_RE.test(evidenceText)) {
    return null;
  }

  const hardQuota = HARD_QUOTA_RE.test(evidenceText);
  const providerWrapper = CLEAN_EXIT_PROVIDER_WRAPPER_RE.test(evidenceText);
  const toolFailureOnly =
    (input.toolErrors?.length ?? 0) > 0 &&
    input.terminalErrors.length === 0 &&
    !input.errorMessage?.trim();
  const transientStatus = facts.statusCodes.some(
    (status) => status === 429 || (status >= 500 && status <= 599),
  );
  const transientCode = facts.codes.some((code) => TRANSIENT_CODE_RE.test(code));
  const transientStatusText = TRANSIENT_STATUS_TEXT_RE.test(evidenceText);
  const transientText = TRANSIENT_TEXT_RE.test(evidenceText);

  // Tool execution failures are a separate failure domain. If OpenCode only
  // reported tool errors, do not infer a model-provider failure from generic
  // status text on stderr. A provider wrapper is required to override this.
  if (toolFailureOnly && !providerWrapper) {
    return null;
  }

  // OpenCode can swallow provider failures and exit 0 with no assistant output.
  // For that clean-empty shape, require strong provider evidence rather than a
  // generic phrase such as "rate limit" that could appear in benign logs.
  if (exitCode === 0 && !hasStructuredTerminalFailure) {
    const strongCleanExitEvidence =
      transientStatus ||
      transientCode ||
      transientStatusText ||
      (providerWrapper && (hardQuota || transientText));
    if (!strongCleanExitEvidence) return null;
  }

  // Strong usage/session/billing evidence wins over a generic HTTP 429.
  if (hardQuota) {
    return {
      errorFamily: "provider_quota",
      retryNotBefore: resolveRetryNotBefore(facts, evidenceText, now),
    };
  }

  if (!transientStatus && !transientCode && !transientStatusText && !transientText) {
    return null;
  }

  return {
    errorFamily: "transient_upstream",
    retryNotBefore: resolveRetryNotBefore(facts, evidenceText, now),
  };
}
