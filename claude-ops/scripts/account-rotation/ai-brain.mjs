#!/usr/bin/env node
/**
 * AI-brain fallback for the OAuth browser driver.
 *
 * Runs when the hard-coded playwright flow stalls on an unexpected page
 * (new Google challenge type, Cloudflare interstitial, unseen cookie modal,
 * terms-acceptance wall, workspace admin re-consent, etc.). Sends a PNG
 * screenshot + DOM summary to Claude and executes the returned action.
 *
 * Safety caps:
 *   - MAX_DECISIONS per rotation      (cost + runaway guard)
 *   - screenshot ≤ 1.5MB, DOM text ≤ 6KB in the prompt
 *   - passwords NEVER leave the machine; fill_password uses local dcli
 *   - abort terminates the flow; never retry on abort
 */
import { execFileSync } from 'child_process';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_DECISIONS = 6;
const REQUEST_TIMEOUT_MS = 30_000;

const GOTO_ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'claude.ai',
  'www.claude.ai',
  'platform.claude.com',
  'accounts.google.com',
  'myaccount.google.com',
  'oauth2.googleapis.com',
  'login.microsoftonline.com',
]);

function isAllowedGotoUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (GOTO_ALLOWED_HOSTS.has(host)) return true;
    if (host.endsWith('.google.com')) return true;
    return false;
  } catch {
    return false;
  }
}

// ── Resolve API key from env → Doppler → keychain ────────────────────────────
function readCommand(argv, timeout = 4000) {
  try {
    return execFileSync(argv[0], argv.slice(1), {
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-')) {
    return process.env.ANTHROPIC_API_KEY;
  }
  // Optional Doppler lookup — set CLAUDE_ROTATOR_DOPPLER_PROJECTS as a
  // comma-separated list of "<project>:<config>" pairs (e.g. "myapp:prd,other:dev").
  const dopplerSpec = process.env.CLAUDE_ROTATOR_DOPPLER_PROJECTS || '';
  const dopplerTargets = dopplerSpec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':'))
    .filter((p) => p.length === 2);
  for (const [project, config] of dopplerTargets) {
    const out = readCommand([
      'doppler',
      'secrets',
      'get',
      'ANTHROPIC_API_KEY',
      '--project',
      project,
      '--config',
      config,
      '--plain',
    ]);
    if (out.startsWith('sk-ant-')) return out;
  }
  // macOS keychain — account name = current OS user (matches rotate.mjs convention)
  const kcAccount = process.env.USER || process.env.LOGNAME || 'claude-ops';
  const kc = readCommand(['security', 'find-generic-password', '-s', 'anthropic-api-key', '-a', kcAccount, '-w'], 2000);
  if (kc.startsWith('sk-ant-')) return kc;
  return null;
}

// ── AWS Bedrock detection ─────────────────────────────────────────────────────
function canUseBedrock() {
  // Bedrock is available if AWS CLI is installed and caller-identity works
  try {
    execFileSync('aws', ['sts', 'get-caller-identity'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

async function askViaBedrock(model, content, log) {
  // Map claude-haiku-4-5 → anthropic.claude-3-5-haiku-20241022-v1:0
  const bedrockModelMap = {
    'claude-haiku-4-5': 'us.anthropic.claude-3-5-haiku-20241022-v2:0',
    'claude-sonnet-4-5': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'claude-opus-4-8': 'us.anthropic.claude-opus-4-8-20250514-v1:0',
    'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v2:0',
  };
  const bedrockModel = bedrockModelMap[model] || 'us.anthropic.claude-3-5-haiku-20241022-v2:0';
  const region = process.env.AWS_BEDROCK_REGION || 'us-east-1';

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 400,
    messages: [{ role: 'user', content }],
  };

  try {
    const result = execFileSync(
      'aws',
      [
        'bedrock-runtime',
        'invoke-model',
        '--model-id',
        bedrockModel,
        '--region',
        region,
        '--body',
        JSON.stringify(payload),
        '/dev/stdout',
      ],
      {
        timeout: REQUEST_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const data = JSON.parse(result.toString());
    const text = (data?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join(' ');
    const parsed = parseActionJson(text);
    if (parsed && parsed.action) {
      log(`bedrock → ${parsed.action} ${parsed.reason || ''}`);
      return parsed;
    }
    log(`bedrock returned unparseable: ${String(text).slice(0, 120)}`);
    return { action: 'abort', reason: 'bedrock_unparseable' };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    log(`bedrock error: ${msg}`);
    return { action: 'abort', reason: `bedrock_error: ${msg.slice(0, 80)}` };
  }
}

// ── Snapshot: screenshot + structured DOM summary ────────────────────────────
async function snapshotPage(page) {
  let screenshotB64 = null;
  try {
    const buf = await page.screenshot({
      type: 'png',
      fullPage: false,
      timeout: 5000,
    });
    if (buf && buf.length < 1_500_000) {
      screenshotB64 = Buffer.from(buf).toString('base64');
    }
  } catch {}
  let domSummary = '';
  try {
    domSummary = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.visibility !== 'hidden' &&
          s.display !== 'none' &&
          parseFloat(s.opacity || '1') > 0.1
        );
      };
      const sel =
        'button, a, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], li[data-challengetype]';
      const nodes = [...document.querySelectorAll(sel)];
      const items = [];
      for (const n of nodes) {
        if (items.length >= 60) break;
        if (!visible(n)) continue;
        const tag = n.tagName.toLowerCase();
        const type = n.getAttribute('type') || '';
        const id = n.id || '';
        const testid = n.getAttribute('data-testid') || '';
        const name = n.getAttribute('name') || '';
        const challenge = n.getAttribute('data-challengetype') || '';
        const cls = (n.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.');
        const ariaLabel = n.getAttribute('aria-label') || '';
        const rawText =
          type === 'password'
            ? '(password — masked)'
            : (n.innerText || n.value || n.placeholder || ariaLabel || '').trim();
        const txt = rawText.slice(0, 120);
        items.push(
          `  ${tag}${type ? '[' + type + ']' : ''}${id ? ' #' + id : ''}${
            testid ? ' data-testid=' + testid : ''
          }${name ? ' name=' + name : ''}${
            challenge ? ' data-challengetype=' + challenge : ''
          }${cls ? ' .' + cls : ''} :: ${txt}`,
        );
      }
      const title = (document.title || '').slice(0, 200);
      const headings = [...document.querySelectorAll('h1, h2, h3')]
        .slice(0, 6)
        .map((e) => (e.innerText || '').trim())
        .filter(Boolean)
        .join(' | ');
      const bodyText = (document.body?.innerText || '').slice(0, 2000);
      return `TITLE: ${title}\nHEADINGS: ${headings}\n---INTERACTIVE ELEMENTS---\n${items.join(
        '\n',
      )}\n---VISIBLE TEXT (trimmed)---\n${bodyText}`;
    });
  } catch (e) {
    domSummary = `[dom extraction failed: ${String(e.message || e).slice(0, 80)}]`;
  }
  let url = '';
  try {
    url = page.url();
  } catch {}
  if (domSummary.length > 6000) domSummary = domSummary.slice(0, 6000) + '\n[truncated]';
  return { screenshotB64, domSummary, url };
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(snapshot, account, attempt, history, stallReason) {
  const orgHint = account.orgName
    ? `Target Claude org/workspace: ${account.orgName}`
    : 'Target Claude org/workspace: Personal (default)';
  return [
    'You are an automation agent driving a Chrome browser through Google OAuth and claude.ai login.',
    `Goal: complete login as ${account.email} and reach the Claude CLI localhost callback so a refresh token is issued.`,
    orgHint,
    '',
    `Stall reason: ${stallReason}`,
    `Current URL: ${snapshot.url || '(unknown)'}`,
    '',
    'Page snapshot (DOM summary):',
    snapshot.domSummary,
    '',
    history.length
      ? `Previous AI-brain decisions this rotation:\n${history.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`
      : 'No prior AI-brain decisions yet.',
    '',
    `Attempt ${attempt}/${MAX_DECISIONS}.`,
    '',
    'Return ONLY one JSON object. No prose, no markdown fences.',
    'Schema: { "action": "click|fill|fill_password|goto|wait|abort", "selector"?: string, "value"?: string, "url"?: string, "reason": string }',
    '',
    'Rules:',
    '- action=click: `selector` is either a precise CSS selector or the EXACT visible text of the element.',
    '- action=fill: `selector` is a CSS selector; `value` is the literal text to type. NEVER pass a password here.',
    '- action=fill_password: the automation will inject the stored Google password into `selector` (defaults to input[type=password]).',
    '- action=goto: `url` is an absolute URL to navigate to (only for Claude or Google auth hosts).',
    '- action=wait: no fields; use when the page is still loading and a re-check is the right move.',
    '- action=abort: ONLY for dead-ends — account locked, human-only CAPTCHA, wrong account with no switch UI, subscription canceled.',
    "- Prefer the natural next step: 'Continue', 'Next', 'Authorize', 'Allow', 'Try another way', picking the target email in an account chooser, the correct workspace in the Claude org chooser.",
    "- NEVER click 'Don't allow', 'Cancel', 'Forget this device', 'Remove account', 'Delete', or any destructive option.",
    '- Language-tolerant: Dutch / German / French / Spanish variants are all valid.',
    "- reCAPTCHA/hCaptcha checkbox: try clicking once; invisible challenge → abort with reason='captcha'.",
    '- If the page is just a spinner with no interactive elements yet, action=wait.',
  ].join('\n');
}

function parseActionJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// ── Public: ask Claude what to do ─────────────────────────────────────────────
export async function askAIBrain({ page, account, history, stallReason, logger }) {
  const log = logger || ((m) => console.error(`[ai-brain] ${m}`));
  const apiKey = resolveApiKey();
  const useBedrock = !apiKey && canUseBedrock();

  if (!apiKey && !useBedrock) {
    log('no ANTHROPIC_API_KEY available (env, Doppler, keychain all empty) and AWS Bedrock not available');
    return { action: 'abort', reason: 'no_api_key' };
  }

  const attempt = history.length + 1;
  if (attempt > MAX_DECISIONS) {
    return { action: 'abort', reason: `decision_cap_${MAX_DECISIONS}` };
  }
  const snap = await snapshotPage(page);
  const prompt = buildPrompt(snap, account, attempt, history, stallReason);

  const content = [];
  if (snap.screenshotB64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: snap.screenshotB64,
      },
    });
  }
  content.push({ type: 'text', text: prompt });

  const model = process.env.CLAUDE_ROTATOR_BRAIN_MODEL || DEFAULT_MODEL;

  if (useBedrock) {
    log(`asking ${model} via AWS Bedrock (attempt ${attempt}/${MAX_DECISIONS}) — stall: ${stallReason}`);
    return askViaBedrock(model, content, log);
  }

  log(`asking ${model} (attempt ${attempt}/${MAX_DECISIONS}) — stall: ${stallReason}`);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data?.error?.message || data?.error?.type || `http_${res.status}`;
      log(`api error: ${String(reason).slice(0, 160)}`);
      return {
        action: 'abort',
        reason: `api_error: ${String(reason).slice(0, 80)}`,
      };
    }
    const text = (data?.content || [])
      .map((p) => p?.text || '')
      .join('')
      .trim();
    const action = parseActionJson(text);
    if (!action || !action.action) {
      log(`unparseable response: ${text.slice(0, 120)}`);
      return { action: 'abort', reason: 'unparseable_response' };
    }
    log(
      `decided: ${action.action}${action.selector ? ` selector=${String(action.selector).slice(0, 60)}` : ''}${action.url ? ` url=${String(action.url).slice(0, 60)}` : ''} — ${String(action.reason || '').slice(0, 80)}`,
    );
    return action;
  } catch (e) {
    log(`call failed: ${String(e.message || e).slice(0, 120)}`);
    return {
      action: 'abort',
      reason: `call_failed: ${String(e.message || e).slice(0, 80)}`,
    };
  }
}

// ── Execute the returned action against the existing driver ──────────────────
export async function executeAIAction(driver, action, { googlePassword } = {}) {
  if (!action || !action.action) return false;
  try {
    switch (action.action) {
      case 'click': {
        if (!action.selector) return false;
        return await driver.findAndClick([action.selector]);
      }
      case 'fill': {
        if (!action.selector) return false;
        return await driver.fillInput(action.selector, action.value || '');
      }
      case 'fill_password': {
        if (!googlePassword) return false;
        const sel = action.selector || 'input[type="password"]';
        return await driver.fillInput(sel, googlePassword);
      }
      case 'goto': {
        if (!action.url || !isAllowedGotoUrl(action.url)) return false;
        await driver.goto(action.url);
        return true;
      }
      case 'wait': {
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      }
      case 'abort':
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ── Best-effort post-OAuth billing scrape ────────────────────────────────────
// Reads the authenticated claude.ai billing settings page and pulls a coarse
// billing snapshot { credits_usd, auto_reload_enabled, extra_usage_enabled }.
// Purely optional telemetry: the authoritative billing signal already comes from
// the /oauth/usage + /oauth/profile API path in rotate.mjs. This scrape only
// enriches state.accounts[key].lastBilling. It MUST NEVER throw — any failure
// (no page, navigation block, unparseable DOM) resolves to null, which the
// caller treats as "skip the merge".
const BILLING_URL = 'https://platform.claude.com/settings/billing';

export async function scrapeBillingState(page, log = () => {}) {
  if (!page || typeof page.goto !== 'function') return null;
  if (!isAllowedGotoUrl(BILLING_URL)) return null;
  try {
    await page.goto(BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Settle async billing widgets; ignore networkidle timeout on chatty pages.
    try {
      await page.waitForLoadState('networkidle', { timeout: 8_000 });
    } catch {}

    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!text || text.length < 8) return null;

    // credits_usd — first dollar amount near a "credit"/"balance" mention.
    let credits_usd = null;
    const creditLine = text
      .split('\n')
      .find((l) => /credit|balance/i.test(l) && /\$\s?\d/.test(l));
    const dollarMatch = (creditLine || '').match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
    if (dollarMatch) {
      const n = parseFloat(dollarMatch[1].replace(/,/g, ''));
      if (Number.isFinite(n)) credits_usd = n;
    }

    // auto_reload_enabled — explicit on/off copy near "auto reload".
    let auto_reload_enabled = null;
    const reloadMatch = text.match(/auto[\s-]?reload[^\n]*?\b(on|off|enabled|disabled)\b/i);
    if (reloadMatch) {
      auto_reload_enabled = /on|enabled/i.test(reloadMatch[1]);
    }

    // extra_usage_enabled — "extra usage" / "overage" on/off copy.
    let extra_usage_enabled = null;
    const extraMatch = text.match(
      /(?:extra usage|overage)[^\n]*?\b(on|off|enabled|disabled)\b/i,
    );
    if (extraMatch) {
      extra_usage_enabled = /on|enabled/i.test(extraMatch[1]);
    }

    // Nothing parsed → return null rather than an empty object.
    if (credits_usd === null && auto_reload_enabled === null && extra_usage_enabled === null) {
      return null;
    }
    log(
      `[scrape-billing] credits=${credits_usd} auto_reload=${auto_reload_enabled} extra_usage=${extra_usage_enabled}`,
    );
    return { credits_usd, auto_reload_enabled, extra_usage_enabled };
  } catch (e) {
    log(`[scrape-billing] skipped: ${String(e.message || e).slice(0, 100)}`);
    return null;
  }
}

export const AI_BRAIN_MAX_DECISIONS = MAX_DECISIONS;
