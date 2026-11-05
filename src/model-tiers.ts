/**
 * The one place to change a model's price tier, shown in the Hermes picker as a mark like "●○○ / low".
 * Tiers only: no price reaches an operator.
 *
 * How to tier: blended = (3 × input + output) / 4, in USD per million tokens, ignoring cached-input discounts.
 *   low: under 0.50    medium: 0.50 up to 1.50    high: 1.50 and over
 * Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ (page updated 2026-10-20).
 *
 * A model missing from this list shows no mark. Changes reach a user at their next boot.
 */
export type ModelTier = "low" | "medium" | "high";

export const MODEL_TIERS: Record<string, ModelTier> = {
  "@cf/google/gemma-4-26b-a4b-it": "low",
  "@cf/openai/gpt-oss-20b": "low",
  "@cf/zai-org/glm-5.3-flash": "low",
  "@cf/moondream/moondream3.1-9B-A2B": "low",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": "medium",
  "@cf/deepseek-ai/deepseek-v4-flash-0731": "medium",
  "@cf/qwen/qwen3.8-27b": "medium",
  "@cf/moonshotai/kimi-k2.6": "high",
  "@cf/moonshotai/kimi-k2.7-code": "high",
  "@cf/deepseek-ai/deepseek-v4-pro-0813": "high",
  "@cf/zai-org/glm-5.3": "high",
};
