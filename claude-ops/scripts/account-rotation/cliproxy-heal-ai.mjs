/**
 * Bounded generative advisor for the CLIProxy healer.
 * Talks to the local CLIProxy OpenAI-compat endpoint. Hard quota rules in
 * cliproxy-heal-policy.mjs always win; this module only proposes JSON.
 */
import { ACTIONS } from './cliproxy-heal-policy.mjs';

const DEFAULT_MODEL = process.env.CLIPROXY_HEAL_MODEL || 'grok-3-mini';
const REQUEST_TIMEOUT_MS = 20_000;

export function buildHealerPrompt(facts) {
  return [
    'You advise a CLIProxy seat rotator. Return ONLY one JSON object. No markdown.',
    `Schema: {"inRotation": true|false, "action": "${Object.values(ACTIONS).join('|')}", "reason": "short"}`,
    'Hard rules you must obey:',
    '- Remaining, reset, or newly observed quota → inRotation true. No hysteresis.',
    '- inRotation false only if quota is certainly exhausted AND a parseable reschedule datetime exists.',
    '- Uncertain exhaust (no proven quota exhausted, or no stamp) → inRotation true (heal/keep serving).',
    '- Paid leftover quota stays serving.',
    '',
    'Facts:',
    JSON.stringify(facts),
  ].join('\n');
}

export function parseAdviceText(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function askCliproxyHealer(facts, { baseUrl, apiKey, model, fetchImpl } = {}) {
  const urlBase = (baseUrl || process.env.CLIPROXY_HEAL_BASE_URL || process.env.CLIPROXYAPI_BASE_URL || '').replace(
    /\/$/,
    '',
  );
  const key = apiKey || process.env.CLIPROXY_API_KEY || process.env.CLIPROXYAPI_KEY || '';
  if (!urlBase || !key) {
    return { inRotation: facts?.hard?.inRotation, action: facts?.hard?.action, reason: 'no_cliproxy_endpoint' };
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  const res = await fetchFn(`${urlBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      temperature: 0,
      max_tokens: 220,
      messages: [{ role: 'user', content: buildHealerPrompt(facts) }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      inRotation: facts?.hard?.inRotation,
      action: facts?.hard?.action,
      reason: `http_${res.status}`,
    };
  }
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
  const parsed = parseAdviceText(text);
  return (
    parsed || {
      inRotation: facts?.hard?.inRotation,
      action: facts?.hard?.action,
      reason: 'unparseable_model',
    }
  );
}
