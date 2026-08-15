/**
 * Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
 * call index. An empty initial reasoning delta does not open a block, and empty or null continuation
 * tool identity fields do not erase established values. Tool-call identity, indices, argument
 * fragments, and token counts are validated before they become completed harness values. Finish
 * reason and the latest usage are deferred until `[DONE]`, covering both finish-attached and trailing
 * usage-only shapes while ensuring no chunk follows `finish`.
 *
 * Translate DeepSeek wire chunks into the harness `StreamChunk` protocol.
 * @module dsh-llm-deepseek/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/** Throw the provider-neutral classification for an invalid DeepSeek response field. */
function malformedResponse(message: string): never {
  throw new LlmError(`malformed DeepSeek response: ${message}`, 'MALFORMED_RESPONSE')
}

/** Validate one token-count field received from the provider. */
function tokenCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformedResponse(`${field} must be a nonnegative safe integer`)
  }
  return value
}

/** Validate one optional token-count field, treating null as absent. */
function optionalTokenCount(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : tokenCount(value, field)
}

/** Read and validate one optional nested usage count. */
function optionalUsageDetail(container: unknown, containerField: string, field: string): number | undefined {
  if (container === undefined || container === null) return undefined
  if (typeof container !== 'object' || Array.isArray(container)) {
    malformedResponse(`${containerField} must be an object or null`)
  }
  return optionalTokenCount((container as Record<string, unknown>)[field], `${containerField}.${field}`)
}

/**
 * Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
 * api/create-chat-completion); the harness TokenUsage convention is
 * DISJOINT counts, so cache reads are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 * @throws LlmError with `MALFORMED_RESPONSE` when a count is not a nonnegative safe integer or cache
 *   reads exceed total prompt tokens.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const promptTokens = tokenCount(usage.prompt_tokens, 'usage.prompt_tokens')
  const completionTokens = tokenCount(usage.completion_tokens, 'usage.completion_tokens')
  const detailedCacheRead = optionalUsageDetail(
    usage.prompt_tokens_details,
    'usage.prompt_tokens_details',
    'cached_tokens',
  )
  const cacheRead = detailedCacheRead
    ?? optionalTokenCount(usage.prompt_cache_hit_tokens, 'usage.prompt_cache_hit_tokens')
  const reasoning = optionalUsageDetail(
    usage.completion_tokens_details,
    'usage.completion_tokens_details',
    'reasoning_tokens',
  )
  if (cacheRead !== undefined && cacheRead > promptTokens) {
    malformedResponse('usage cache-read tokens cannot exceed usage.prompt_tokens')
  }
  return {
    inputTokens: promptTokens - (cacheRead ?? 0),
    outputTokens: completionTokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': {
      if (block.callId === undefined || block.name === undefined) {
        const missing = [block.callId === undefined ? 'id' : undefined, block.name === undefined ? 'name' : undefined]
          .filter(value => value !== undefined)
          .join(' and ')
        malformedResponse(`tool call never provided a non-empty ${missing}`)
      }
      return {
        type: 'tool-call',
        id: CallId(block.callId),
        name: block.name,
        arguments: block.text,
      }
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads and invalid tool-call or usage fields abort the stream with
 * `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      const completed = order.map(block => ({ open: block, content: closeBlock(block) }))
      for (const block of completed) {
        yield { type: 'block-end', index: block.open.index, block: block.content }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        const wireIndex: unknown = call.index
        if (typeof wireIndex !== 'number' || !Number.isSafeInteger(wireIndex) || wireIndex < 0) {
          malformedResponse('tool_calls[].index must be a nonnegative safe integer')
        }
        let block = toolBlocks.get(wireIndex)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(wireIndex, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const id: unknown = call.id
        if (id !== undefined && id !== null && typeof id !== 'string') {
          malformedResponse('tool_calls[].id must be a string or null')
        }
        if (typeof id === 'string' && id.length > 0) block.callId = id
        const name: unknown = call.function?.name
        if (name !== undefined && name !== null && typeof name !== 'string') {
          malformedResponse('tool_calls[].function.name must be a string or null')
        }
        if (typeof name === 'string' && name.length > 0) block.name = name
        const argumentValue: unknown = call.function?.arguments
        if (argumentValue !== undefined && argumentValue !== null && typeof argumentValue !== 'string') {
          malformedResponse('tool_calls[].function.arguments must be a string or null')
        }
        const fragment = typeof argumentValue === 'string' ? argumentValue : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
