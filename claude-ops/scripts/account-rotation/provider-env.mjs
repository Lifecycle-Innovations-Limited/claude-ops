// provider-env.mjs — shared provider-env helpers for the rotation daemon.
//
// Single source of truth for switching a child env between Bedrock (metered,
// AWS-backed) and OAuth (Claude Max, free-until-cap). The model-var scrub is the
// correctness fix: when we flip a session FROM Bedrock TO OAuth we must NOT leave
// hardcoded Bedrock model ids (e.g. ANTHROPIC_MODEL=anthropic.claude-fable-5) or
// AWS_* credentials in the env — those ids are invalid against the OAuth API and
// the AWS vars keep the session pointed at metered Bedrock inference.
//
// Sam directive (2026-06-14): "Bedrock should never be in use if any /rotate
// OAuth account has tokens available." On a successful OAuth swap the model
// resets to the user's default subscription catalog (accepted: "auto reset to
// default model").

/**
 * Every env var that pins a session to Bedrock / hardcodes a Bedrock model id.
 * Mirrors claude-settings-mode.mjs `clearHardcodedModelsForOAuthClaudeSettings`
 * (plus the AWS credential/profile vars that route inference to Bedrock).
 * Keep this list in sync with that function.
 */
export const BEDROCK_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEDROCK_REGION',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
];

/**
 * Remove every Bedrock-pinning var from `env` in place. Returns the same object.
 * Use when switching a session TO OAuth.
 * @param {Record<string,string>} env
 * @returns {Record<string,string>}
 */
export function scrubBedrockEnv(env) {
  if (!env || typeof env !== 'object') return env;
  for (const k of BEDROCK_ENV_KEYS) {
    delete env[k];
  }
  return env;
}

/**
 * Map a Bedrock inference-profile / model id to its plain OAuth model id.
 *   us.anthropic.claude-fable-5            -> claude-fable-5
 *   anthropic.claude-fable-5-v1:0          -> claude-fable-5
 *   eu.anthropic.claude-sonnet-4-6         -> claude-sonnet-4-6
 *   global.anthropic.claude-opus-4-1-v1:0  -> claude-opus-4-1
 * Strips the region-profile prefix (us./eu./apac./global.), the `anthropic.`
 * vendor prefix, and any trailing `-vN:N` / `:vN:N` version flag.
 * Returns null when the result is not a `claude-*` id (unknown/unmappable).
 * @param {string} id
 * @returns {string|null}
 */
export function bedrockModelToOAuth(id) {
  if (!id || typeof id !== 'string') return null;
  let out = id.trim();
  // Strip region-profile prefix (us. / eu. / apac. / global.).
  out = out.replace(/^(us|eu|apac|global)\./i, '');
  // Strip the vendor prefix.
  out = out.replace(/^anthropic\./i, '');
  // Strip a trailing version flag: -v1:0, :v1:0, -v1, etc.
  out = out.replace(/[-:]v\d+(:\d+)?$/i, '');
  return /^claude-/.test(out) ? out : null;
}

/**
 * Switch `env` to OAuth: scrub all Bedrock vars and set the OAuth token.
 * The model intentionally resets to the user's default subscription catalog.
 * @param {Record<string,string>} env
 * @param {string} oauthToken  the bare access token string
 * @returns {Record<string,string>}
 */
export function applyOAuthEnv(env, oauthToken) {
  scrubBedrockEnv(env);
  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
}

/**
 * Switch `env` to Bedrock fallback: set the Bedrock vars and drop any OAuth token.
 * Mirrors the bedrock branch in bg-respawn.doRespawn / session-router.spawnWithAccount.
 * @param {Record<string,string>} env
 * @param {string} [region='us-east-1']
 * @param {{primary?:string}} [models]  optional model overrides; defaults to fable.
 * @returns {Record<string,string>}
 */
export function applyBedrockEnv(env, region = 'us-east-1', models = {}) {
  env.CLAUDE_CODE_USE_BEDROCK = '1';
  env.AWS_BEDROCK_REGION = region;
  env.AWS_REGION = region;
  env.ANTHROPIC_MODEL = models.primary || 'anthropic.claude-fable-5';
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}
