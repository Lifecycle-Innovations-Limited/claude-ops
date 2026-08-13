const UNSUPPORTED_FABLE_MODELS = /^(?:fable|claude-fable-5)(?:\[[^\]]+\])?$/i;
const CANONICAL_FABLE_REPLACEMENT = 'gpt-5.4';

export function normalizeClaudeModelValue(value) {
  if (typeof value !== 'string' || !UNSUPPORTED_FABLE_MODELS.test(value)) return value;
  return CANONICAL_FABLE_REPLACEMENT;
}

export function normalizeClaudeModelArgs(args) {
  if (!Array.isArray(args)) return args;

  const normalized = [...args];
  for (let i = 0; i < normalized.length; i += 1) {
    const arg = normalized[i];
    if (arg === '--model' && i + 1 < normalized.length) {
      normalized[i + 1] = normalizeClaudeModelValue(normalized[i + 1]);
      i += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--model=')) {
      normalized[i] = `--model=${normalizeClaudeModelValue(arg.slice('--model='.length))}`;
    }
  }
  return normalized;
}
