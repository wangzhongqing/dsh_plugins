/**
 * Derive pi-ai reasoning metadata from OpenCode model variants.
 * @module dsh-opencode-zen-connect/reasoning
 *
 * OpenCode publishes per-model `variants` (e.g. deepseek-v4.1-flash-free has
 * {low, high, max}). DSH builds the model picker's reasoning-effort dropdown
 * exclusively from a pi-ai model's `reasoning` flag + `thinkingLevelMap`, so
 * we translate the OpenCode variants into that shape here.
 *
 * This module is intentionally dependency-free so it can be unit-tested
 * without loading the host's plugin runtime.
 */

/** pi-ai thinking levels, in escalation order. `off` is handled separately. */
export const THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Build the `reasoning` fields for a pi-ai model descriptor from an OpenCode
 * variant map.
 *
 * - A variant that is a valid pi level is mapped to itself: DSH then emits
 *   `reasoning_effort: <level>`, which the shim forwards as OpenCode's
 *   `variant` field (verified against the running opencode server).
 * - Levels the model does not advertise are pinned to `null`, which is how
 *   pi-ai/DSH mark a level as unsupported. This matters because pi-ai treats
 *   an *undefined* mapping for minimal/low/medium/high as "supported, use the
 *   provider default"; without the explicit nulls, every model would offer
 *   all four levels regardless of what it actually supports.
 * - `off` is deliberately left unset: with no configured effort, pi-ai sends
 *   no `reasoning_effort`, so OpenCode uses its own default variant.
 *
 * @param {Record<string, unknown> | undefined | null} variants
 * @returns {{ reasoning: boolean, thinkingLevelMap?: Record<string, string | null> }}
 */
export function reasoningFromVariants(variants) {
  if (variants === undefined || variants === null || typeof variants !== 'object') {
    return { reasoning: false }
  }

  const hasVariant = level => Object.prototype.hasOwnProperty.call(variants, level)
  const supported = THINKING_LEVELS.filter(hasVariant)
  if (supported.length === 0) return { reasoning: false }

  const thinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    thinkingLevelMap[level] = hasVariant(level) ? level : null
  }
  return { reasoning: true, thinkingLevelMap }
}
