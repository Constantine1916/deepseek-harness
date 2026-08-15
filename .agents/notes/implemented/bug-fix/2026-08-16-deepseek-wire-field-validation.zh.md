# Agent Note: DeepSeek wire 字段在形成无效工具或 usage 状态前失败

Status: implemented

[English](2026-08-16-deepseek-wire-field-validation.md) | 中文

## 问题

DeepSeek 流转换器在解析 JSON 后，于运行时信任了若干只受 TypeScript 声明约束的字段。一个始终没有提供可用 id 或 name 的工具调用会用空字符串兜底完成，因此 loop 可能尝试执行 `unknown tool ""`，并持久化空 call id。缺失、null、小数或负数的工具调用 index 可能创建错误的组装块，或把不同调用合并到一起。缺失或无效的 usage 计数可能产生 `undefined`、`NaN`、负数或 null token 值，随后进入会话投影和上下文计算。

## 决策

适配器在消费外部字段时进行校验，并将违例报告为 `LlmError('MALFORMED_RESPONSE')`。工具调用 index 必须是非负安全整数；id 和 name 字段必须是字符串或 null；参数分片必须是字符串或 null；最终完成时必须具有非空 id 和 name。后续分片中的空字符串或 null 身份字段仍被视为没有更新，不能清除已确定的值。`[DONE]` 路径会先校验所有已完成块，再产生任何 `block-end`，因此身份不完整的工具调用不会成为可执行内容块。

Usage 映射要求 `prompt_tokens` 和 `completion_tokens` 是非负安全整数。可选的 cache 与 reasoning 计数把 null 视为缺失，拒绝其他无效值，而且 cache read 不能超过 prompt token 总数。wire 类型会记录提供方字段可以为 null 或缺失，而运行时校验仍是权威，因为解析后的 JSON 不受信任。

## 验证

聚焦的转换器覆盖会验证有效的分片与并行调用、空字符串和 null 的后续身份字段、每一种身份缺失组合、无效或缺失的 index、null 和非字符串参数分片、必需与可选 usage 计数、可为 null 的 detail 容器，以及超过 prompt token 总数的 cache 计数。

## 考虑过的替代方案

**继续用空字符串完成身份不完整的调用。** 这种做法保留了宽松的流，却把提供方协议违例转换成无关的工具查找失败，并允许无效 call id 进入持久状态。

**强制转换或截断无效 token 计数。** 这种做法让流继续运行，却会捏造计量事实，并隐藏导致上下文和遥测计算不可靠的提供方响应。

**通过一个整 payload schema 校验所有 chat-completions 字段。** 完整 schema 校验会为转换器不消费的字段引入更广泛的兼容策略。适配器改为在每个外部值即将影响 harness 状态的位置校验它。

## 后果

含有无效已消费字段的提供方流会在适配器处失败，而不是调度空名称工具或发布损坏的 token 计量。兼容的流仍允许后续字段缺失或为 null，也允许可选 usage 指标缺失。校验为转换器增加了明确的失败分支，但每个分支都会指出被拒绝的字段，并共享既有的提供方无关错误代码。
