import { describe, expect, it } from "vitest";
import {
  classifyOpenCodeProviderFailure,
  type OpenCodeProviderFailureInput,
} from "./provider-failure.js";

const NOW = new Date("2030-04-22T20:00:00.000Z");

function classify(
  payload: unknown,
  overrides: Partial<OpenCodeProviderFailureInput> = {},
) {
  return classifyOpenCodeProviderFailure(
    {
      terminalErrors: [{ message: "", payload }],
      stderr: "",
      errorMessage: null,
      exitCode: 1,
      hasOutput: false,
      ...overrides,
    },
    NOW,
  );
}

describe("classifyOpenCodeProviderFailure", () => {
  it("classifies actual usage exhaustion as provider_quota and preserves an absolute reset", () => {
    expect(
      classify({
        name: "AI_APICallError",
        statusCode: 429,
        message: "You've hit your usage limit for GPT-5.",
        data: { resetAt: "2030-04-22T21:30:00.000Z" },
      }),
    ).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: "2030-04-22T21:30:00.000Z",
    });
  });

  it("parses an absolute reset timestamp from quota prose", () => {
    expect(
      classify({
        statusCode: 429,
        message:
          "Usage limit reached for this account. Your limit will reset at 2030-04-22T22:15:00Z",
      }),
    ).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: "2030-04-22T22:15:00.000Z",
    });
  });

  it("classifies usage exhaustion without inventing retry timing", () => {
    expect(
      classify({
        statusCode: 429,
        message: "Weekly limit reached for this account.",
      }),
    ).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: null,
    });
    expect(classify({ message: "Quota exceeded for this account." })).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: null,
    });
  });

  it("treats a plain HTTP 429 as transient_upstream and honors Retry-After", () => {
    expect(
      classify({
        name: "AI_APICallError",
        statusCode: 429,
        message: "Too Many Requests",
        responseHeaders: { "retry-after": "45" },
      }),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2030-04-22T20:00:45.000Z",
    });
  });

  it("treats RESOURCE_EXHAUSTED with RetryInfo as short-lived transient pressure", () => {
    expect(
      classify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Resource has been exhausted (e.g. check quota).",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "27s",
            },
          ],
        },
      }),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2030-04-22T20:00:27.000Z",
    });
  });

  it.each([
    { statusCode: 503, message: "Service temporarily unavailable" },
    { statusCode: 529, message: "Provider overloaded" },
    { code: "overloaded_error", message: "High demand, try again later" },
    { statusCode: 429, message: "Model is temporarily at capacity" },
    { message: "The server had an error while processing your request." },
  ])("classifies temporary provider pressure as transient_upstream", (payload) => {
    expect(classify(payload)).toMatchObject({
      errorFamily: "transient_upstream",
    });
  });

  it("lets strong quota evidence win over the generic 429 status", () => {
    expect(
      classify({
        statusCode: 429,
        message: "You've hit your session limit. Try again after 30 minutes.",
      }),
    ).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: "2030-04-22T20:30:00.000Z",
    });
  });

  it.each([
    { statusCode: 401, message: "Invalid API key" },
    { code: "invalid_api_key", statusCode: 401 },
    { statusCode: 404, message: "model_not_found: requested model does not exist" },
    { statusCode: 400, message: "Invalid tool definition: schema is unsupported" },
    { code: "invalid_tool_schema", statusCode: 400 },
    { statusCode: 400, message: "Maximum context length exceeded" },
    { code: "context_length_exceeded", statusCode: 400 },
  ])("does not route deterministic failures into provider retry recovery", (payload) => {
    expect(classify(payload)).toBeNull();
  });

  it("does not classify a tool failure just because the tool returned HTTP 429", () => {
    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          toolErrors: ["Tool request failed: HTTP 429 Too Many Requests"],
          stderr: "Tool request failed: HTTP 429 Too Many Requests",
          errorMessage: null,
          exitCode: 1,
          hasOutput: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("classifies the observed clean-exit RESOURCE_EXHAUSTED stderr shape", () => {
    const stderr = [
      "AI_APICallError: Resource has been exhausted (e.g. check quota).",
      JSON.stringify({
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "27s",
            },
          ],
        },
      }),
    ].join("\n");

    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr,
          errorMessage: null,
          exitCode: 0,
          hasOutput: false,
        },
        NOW,
      ),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2030-04-22T20:00:27.000Z",
    });
  });

  it("does not turn a clean empty run into a failure from generic rate-limit prose alone", () => {
    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr: "debug: rate limit policy loaded successfully",
          errorMessage: null,
          exitCode: 0,
          hasOutput: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("parses textual Retry-After seconds and HTTP dates", () => {
    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr: 'AI_APICallError: Too Many Requests\nstatusCode: 429\nretry-after: "45"',
          errorMessage: null,
          exitCode: 0,
          hasOutput: false,
        },
        NOW,
      ),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2030-04-22T20:00:45.000Z",
    });

    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr:
            'AI_APICallError: Too Many Requests\nstatusCode: 429\nretry-after: "Mon, 22 Apr 2030 20:10:00 GMT"',
          errorMessage: null,
          exitCode: 0,
          hasOutput: false,
        },
        NOW,
      ),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2030-04-22T20:10:00.000Z",
    });
  });

  it("does not backtrack a malformed Retry-After value into a shorter numeric prefix", () => {
    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr: "AI_APICallError: Too Many Requests\nstatusCode: 429\nretry-after: 30 GMT",
          errorMessage: null,
          exitCode: 0,
          hasOutput: false,
        },
        NOW,
      ),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: null,
    });
  });

  it("classifies a text-only HTTP 503 terminal failure as transient_upstream", () => {
    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr: "AI_APICallError: upstream request failed with HTTP 503",
          errorMessage: "AI_APICallError: upstream request failed with HTTP 503",
          exitCode: 1,
          hasOutput: false,
        },
        NOW,
      ),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: null,
    });
  });

  it("does not classify a productive clean run from stderr text alone", () => {
    expect(
      classifyOpenCodeProviderFailure(
        {
          terminalErrors: [],
          stderr: "Previous request saw HTTP 429 Too Many Requests.",
          errorMessage: null,
          exitCode: 0,
          hasOutput: true,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores malformed or past retry timing without dropping the failure family", () => {
    expect(
      classify({
        statusCode: 429,
        message: "Too Many Requests",
        retryNotBefore: "2020-01-01T00:00:00.000Z",
        responseHeaders: { "retry-after": "nonsense" },
      }),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: null,
    });
  });

  it("reads structured JSON embedded in a provider response body", () => {
    expect(
      classify({
        name: "AI_APICallError",
        responseBody: JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Too Many Requests",
            details: [{ retryDelay: "12s" }],
          },
        }),
      }),
    ).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2030-04-22T20:00:12.000Z",
    });
  });
});
