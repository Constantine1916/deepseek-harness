# Agent Note: DeepSeek wire fields fail before invalid tool or usage state

Status: implemented

English | [中文](2026-08-16-deepseek-wire-field-validation.zh.md)

## Problem

The DeepSeek stream translator parsed JSON and then trusted several TypeScript-only field declarations at runtime. A tool call that never supplied a usable id or name was finalized with empty-string fallbacks, so the loop could attempt `unknown tool ""` and persist an empty call id. Missing, null, fractional, or negative tool-call indices could create or merge the wrong assembly block. Missing or invalid usage counts could produce `undefined`, `NaN`, negative, or null token values that then reached session projections and context calculations.

## Decision

The adapter validates the external fields when it consumes them and reports violations as `LlmError('MALFORMED_RESPONSE')`. A tool-call index is a nonnegative safe integer; id and name fields are strings or null; argument fragments are strings or null; and finalization requires a non-empty id and name. Empty or null continuation identity fields remain absent updates and cannot erase an established value. The `[DONE]` path validates every completed block before yielding any `block-end`, so an incomplete tool call cannot become an executable content block.

Usage mapping requires nonnegative safe integers for `prompt_tokens` and `completion_tokens`. Optional cache and reasoning counts treat null as absent, reject other invalid values, and cache reads cannot exceed total prompt tokens. The wire types record nullable and omittable provider fields, while runtime validation remains authoritative because parsed JSON is untrusted.

## Verification

Focused translator coverage exercises valid fragmented and parallel calls, empty and null continuation identity, every missing identity combination, invalid or absent indices, null and non-string argument fragments, required and optional usage counts, nullable detail containers, and cache totals that exceed prompt tokens.

## Alternatives considered

**Continue finalizing incomplete calls with empty strings.** This preserves a permissive stream but converts a provider protocol violation into an unrelated tool lookup failure and permits an invalid call id to enter durable state.

**Coerce or clamp invalid token counts.** This keeps the stream running but invents accounting facts and hides the provider response that caused context and telemetry calculations to become unreliable.

**Validate every chat-completions field through one whole-payload schema.** Full schema validation would add a broader compatibility policy for fields this translator does not consume. The adapter instead validates each externally sourced value at the point where it affects harness state.

## Consequences

Provider streams with invalid consumed fields fail at the adapter instead of dispatching an empty-name tool or publishing corrupt token accounting. Compatible streams retain leniency for omitted and null continuation fields and optional usage metrics. The validation adds explicit failure branches to the translator, but each branch names the rejected field and shares the existing provider-neutral error code.
