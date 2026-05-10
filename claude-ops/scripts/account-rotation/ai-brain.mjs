#!/usr/bin/env node
/**
 * AI-brain fallback for the OAuth browser driver.
 *
 * Runs when the hard-coded playwright flow stalls on an unexpected page
 * (new Google challenge type, Cloudflare interstitial, unseen cookie modal,
 * terms-acceptance wall, workspace admin re-consent, etc.). Sends a PNG
 * screenshot + DOM summary to Claude and executes the returned action.
 *
 * Inference: Amazon Bedrock Converse API only (`POST .../model/{modelId}/converse`).
 * Model IDs follow current AWS Bedrock model cards (e.g. Sonnet 4.6 geo / foundation /
 * global inference profiles — verified via Context7 against AWS documentation).
 * Interactive Claude Max OAuth is separate (Claude Code); this module does not use
 * ANTHROPIC_API_KEY.
 *
 * Safety caps:
 *   - MAX_DECISIONS per rotation      (cost + runaway guard)
 *   - screenshot ≤ 1.5MB, DOM text ≤ 6KB in the prompt
 *   - passwords NEVER leave the machine; fill_password uses local dcli
 *   - abort terminates the flow; never retry on abort
 *   - Optional research: Bedrock text planner may invoke Context7 (npx ctx7) and
 *     web search (DuckDuckGo) before the vision call; disable with CLAUDE_ROTATOR_BRAIN_NO_RESEARCH=1
 */
import { readFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { AwsClient } from "aws4fetch";

const execFileAsync = promisify(execFile);

const BEDROCK_MODEL_DEFAULTS = [
  "us.anthropic.claude-sonnet-4-6",
  "anthropic.claude-sonnet-4-6",
  "global.anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
];
const MAX_DECISIONS = 6;
const REQUEST_TIMEOUT_MS = 30_000;
const RESEARCH_PLANNER_TIMEOUT_MS = 45_000;
const CTX7_EXEC_TIMEOUT_MS = 120_000;
const MAX_RESEARCH_TOOLS = 3;
const MAX_RESEARCH_APPENDIX_CHARS = 12_000;
const WEB_SEARCH_USER_AGENT = "claude-account-rotation-research/1.0";

/** Haiku-first chain for the text-only research planner (cheaper than vision step). */
function plannerModelChain() {
  const envModel = process.env.CLAUDE_ROTATOR_BRAIN_PLANNER_MODEL?.trim();
  const haiku = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const chain = [];
  if (envModel) chain.push(envModel);
  if (!chain.includes(haiku)) chain.push(haiku);
  for (const id of BEDROCK_MODEL_DEFAULTS) {
    if (!chain.includes(id)) chain.push(id);
  }
  return chain;
}

function npxCmd() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** Optional override first, then defaults (no legacy Claude 3.x models). */
function bedrockModelChain() {
  const envModel = process.env.CLAUDE_ROTATOR_BEDROCK_MODEL?.trim();
  const chain = [];
  if (envModel) chain.push(envModel);
  for (const id of BEDROCK_MODEL_DEFAULTS) {
    if (!chain.includes(id)) chain.push(id);
  }
  return chain;
}

function toBedrockMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((c) => {
      if (c.type === "text") return { text: c.text };
      if (c.type === "image") {
        const b64 = c.source?.data;
        if (!b64) return { text: "[image omitted]" };
        return {
          image: {
            format: "png",
            // ImageSource.bytes: base64-encoded image (Bedrock runtime Converse API).
            source: { bytes: b64 },
          },
        };
      }
      return { text: String(c) };
    }),
  }));
}

function extractBedrockText(data) {
  const blocks = data?.output?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).join("").trim();
}

function resolveAwsCredentials() {
  const envPath = join(process.env.HOME || "", ".env");
  let envContent = "";
  try {
    envContent = readFileSync(envPath, "utf8");
  } catch {}

  const getVal = (key) => {
    if (process.env[key]) return process.env[key];
    const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };

  const accessKeyId = getVal("AWS_ACCESS_KEY_ID");
  const secretAccessKey = getVal("AWS_SECRET_ACCESS_KEY");
  const region = getVal("AWS_REGION") || "us-east-1";

  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, region };
  }
  return null;
}

// ── Amazon Bedrock Converse (shared) ─────────────────────────────────────────

/**
 * @param {ReturnType<typeof toBedrockMessages>} bedrockMessages
 * @param {{ inferenceConfig?: object, timeoutMs?: number, modelIds?: string[] | null }} options
 * @returns {Promise<{ ok: boolean, provider: string | null, data: object | null, status: number, modelId?: string }>}
 */
async function invokeBedrockConverse(bedrockMessages, log, options = {}) {
  const inferenceConfig = options.inferenceConfig ?? { maxTokens: 400, temperature: 0 };
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const modelIds = options.modelIds ?? bedrockModelChain();

  const aws = resolveAwsCredentials();
  if (!aws) {
    log("no AWS credentials for Bedrock");
    return { ok: false, provider: null, data: null, status: 0 };
  }

  let lastStatus = 0;
  let lastData = null;

  for (const modelId of modelIds) {
    log(`Bedrock Converse (${modelId})`);
    const client = new AwsClient({
      accessKeyId: aws.accessKeyId,
      secretAccessKey: aws.secretAccessKey,
      region: aws.region,
      service: "bedrock",
    });

    const bedrockUrl = `https://bedrock-runtime.${aws.region}.amazonaws.com/model/${modelId}/converse`;

    try {
      const res = await client.fetch(bedrockUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: bedrockMessages,
          inferenceConfig,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      lastStatus = res.status;
      lastData = data;
      if (res.ok) {
        return { ok: true, provider: "bedrock", data, status: res.status, modelId };
      }
      const errPeek = JSON.stringify(data?.message || data?.error || data).slice(0, 180);
      log(`Bedrock (${modelId}) ${res.status}: ${errPeek}`);
    } catch (e) {
      log(`Bedrock (${modelId}) error: ${String(e.message || e).slice(0, 160)}`);
    }
  }

  return { ok: false, provider: "bedrock", data: lastData, status: lastStatus };
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  let cleaned = text
    .trim()
    .replace(/^```(?:json|JSON)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

function parseResearchPlan(text) {
  const raw = extractFirstJsonObject(text);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.tools)) return null;
    const tools = [];
    for (const t of j.tools) {
      if (t?.tool === "context7") {
        tools.push({
          tool: "context7",
          libraryName: String(t.libraryName || ""),
          libraryQuery: String(t.libraryQuery || ""),
          docsQuery: String(t.docsQuery || ""),
        });
      } else if (t?.tool === "web_search") {
        tools.push({ tool: "web_search", query: String(t.query || "") });
      }
    }
    return { tools };
  } catch {
    return null;
  }
}

function firstContext7LibraryId(stdout) {
  const m = stdout.match(/Context7-compatible library ID:\s*(\/[^\s)\]]+)/);
  if (m) return m[1];
  for (const line of stdout.split("\n")) {
    const m2 = line.trim().match(/^(\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?)\s*$/);
    if (m2) return m2[1];
  }
  return null;
}

async function runContext7Tool(spec, log) {
  const name = String(spec.libraryName || "documentation").trim().slice(0, 120);
  const libraryQuery = String(spec.libraryQuery || "").trim().slice(0, 220);
  const docsQuery = String(spec.docsQuery || "").trim().slice(0, 320);
  if (!libraryQuery || !docsQuery) return "";

  let libraryOut = "";
  try {
    const { stdout } = await execFileAsync(npxCmd(), ["ctx7@latest", "library", name, libraryQuery], {
      maxBuffer: 4_000_000,
      timeout: CTX7_EXEC_TIMEOUT_MS,
      env: process.env,
    });
    libraryOut = stdout || "";
  } catch (e) {
    log(`context7 library failed: ${String(e.message || e).slice(0, 100)}`);
    return "";
  }

  const libId = firstContext7LibraryId(libraryOut);
  if (!libId) {
    return `[context7 library — no id parsed]\n${libraryOut.slice(0, 4000)}`;
  }

  try {
    const { stdout } = await execFileAsync(npxCmd(), ["ctx7@latest", "docs", libId, docsQuery], {
      maxBuffer: 4_000_000,
      timeout: CTX7_EXEC_TIMEOUT_MS,
      env: process.env,
    });
    return `[context7 ${libId}]\n${(stdout || "").slice(0, 6000)}`;
  } catch (e) {
    log(`context7 docs failed: ${String(e.message || e).slice(0, 100)}`);
    return `[context7 ${libId} — library output only]\n${libraryOut.slice(0, 3000)}`;
  }
}

async function runWebSearchTool(query, log) {
  const q = String(query || "")
    .trim()
    .slice(0, 500);
  if (!q) return "";

  try {
    const u = new URL("https://api.duckduckgo.com/");
    u.searchParams.set("q", q);
    u.searchParams.set("format", "json");
    u.searchParams.set("no_html", "1");
    u.searchParams.set("skip_disambig", "1");

    const res = await fetch(u.toString(), {
      signal: AbortSignal.timeout(18_000),
      headers: { Accept: "application/json", "User-Agent": WEB_SEARCH_USER_AGENT },
    });
    if (!res.ok) {
      return `[web_search] HTTP ${res.status} for query: ${q}`;
    }
    const j = await res.json().catch(() => ({}));
    const parts = [];
    if (j.AbstractText) parts.push(String(j.AbstractText));
    if (j.AbstractURL) parts.push(`Source: ${j.AbstractURL}`);
    const topics = Array.isArray(j.RelatedTopics) ? j.RelatedTopics.slice(0, 6) : [];
    for (const t of topics) {
      if (t && typeof t === "object" && t.Text) parts.push(String(t.Text));
    }
    const body = parts.join("\n\n").slice(0, 4500);
    return body || `[web_search] No instant answer for: ${q}`;
  } catch (e) {
    log(`web_search failed: ${String(e.message || e).slice(0, 80)}`);
    return "";
  }
}

async function gatherResearchAppendix({ stallReason, url, domSummary }, log) {
  if (process.env.CLAUDE_ROTATOR_BRAIN_NO_RESEARCH === "1") return "";

  const dom = (domSummary || "").slice(0, 3500);
  const planPrompt = [
    "You choose research tools BEFORE a vision+automation model picks the next browser action.",
    "Flow: Google OAuth and claude.ai login until Claude CLI localhost callback issues a refresh token.",
    "",
    `Stall reason: ${stallReason}`,
    `URL: ${url || "(unknown)"}`,
    "",
    "DOM summary (truncated):",
    dom || "(empty)",
    "",
    "Return ONLY valid JSON, no markdown fences:",
    '{ "tools": [ ... ] }',
    "",
    'Each tool is ONE of:',
    '- { "tool": "context7", "libraryName": "short name for ctx7 library command", "libraryQuery": "disambiguation / ranking query for ctx7 library", "docsQuery": "specific documentation question after library resolves" }',
    '  Use for library docs: Playwright, OAuth2, Google sign-in, Anthropic, AWS Bedrock, etc.',
    '- { "tool": "web_search", "query": "focused query for product errors, new UI strings, time-sensitive messages" }',
    "",
    "Rules:",
    "- If no lookup helps, return { \"tools\": [] }.",
    `- At most ${MAX_RESEARCH_TOOLS} tools.`,
    "- Prefer context7 for API/framework facts; web_search for volatile UI/errors.",
  ].join("\n");

  const planMessages = toBedrockMessages([
    { role: "user", content: [{ type: "text", text: planPrompt }] },
  ]);

  const planResult = await invokeBedrockConverse(planMessages, log, {
    inferenceConfig: { maxTokens: 700, temperature: 0.1 },
    timeoutMs: RESEARCH_PLANNER_TIMEOUT_MS,
    modelIds: plannerModelChain(),
  });

  if (!planResult.ok) {
    log("research planner failed; continuing without appendix");
    return "";
  }

  const planText = extractBedrockText(planResult.data || {});
  const plan = parseResearchPlan(planText);
  if (!plan?.tools?.length) return "";

  const sections = [];
  const tools = plan.tools.slice(0, MAX_RESEARCH_TOOLS);
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (t.tool === "context7" && t.libraryName && t.libraryQuery && t.docsQuery) {
      log(`research [${i + 1}/${tools.length}] context7: ${t.libraryName}`);
      const out = await runContext7Tool(t, log);
      if (out) sections.push(out);
    } else if (t.tool === "web_search" && t.query.trim()) {
      log(`research [${i + 1}/${tools.length}] web_search`);
      const out = await runWebSearchTool(t.query, log);
      if (out) sections.push(out);
    }
  }

  return sections.join("\n\n---\n\n").slice(0, MAX_RESEARCH_APPENDIX_CHARS);
}

// ── Snapshot: screenshot + structured DOM summary ────────────────────────────
async function snapshotPage(page) {
  let screenshotB64 = null;
  try {
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      timeout: 5000,
    });
    if (buf && buf.length < 1_500_000) {
      screenshotB64 = Buffer.from(buf).toString("base64");
    }
  } catch {}
  let domSummary = "";
  try {
    domSummary = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          parseFloat(s.opacity || "1") > 0.1
        );
      };
      const sel =
        "button, a, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], li[data-challengetype]";
      const nodes = [...document.querySelectorAll(sel)];
      const items = [];
      for (const n of nodes) {
        if (items.length >= 60) break;
        if (!visible(n)) continue;
        const tag = n.tagName.toLowerCase();
        const type = n.getAttribute("type") || "";
        const id = n.id || "";
        const testid = n.getAttribute("data-testid") || "";
        const name = n.getAttribute("name") || "";
        const challenge = n.getAttribute("data-challengetype") || "";
        const cls = (n.getAttribute("class") || "")
          .split(/\s+/)
          .slice(0, 2)
          .join(".");
        const ariaLabel = n.getAttribute("aria-label") || "";
        const rawText =
          type === "password"
            ? "(password — masked)"
            : (n.innerText || n.value || n.placeholder || ariaLabel || "").trim();
        const txt = rawText.slice(0, 120);
        items.push(
          `  ${tag}${type ? "[" + type + "]" : ""}${id ? " #" + id : ""}${
            testid ? " data-testid=" + testid : ""
          }${name ? " name=" + name : ""}${
            challenge ? " data-challengetype=" + challenge : ""
          }${cls ? " ." + cls : ""} :: ${txt}`,
        );
      }
      const title = (document.title || "").slice(0, 200);
      const headings = [...document.querySelectorAll("h1, h2, h3")]
        .slice(0, 6)
        .map((e) => (e.innerText || "").trim())
        .filter(Boolean)
        .join(" | ");
      const bodyText = (document.body?.innerText || "").slice(0, 2000);
      return `TITLE: ${title}\nHEADINGS: ${headings}\n---INTERACTIVE ELEMENTS---\n${items.join(
        "\n",
      )}\n---VISIBLE TEXT (trimmed)---\n${bodyText}`;
    });
  } catch (e) {
    domSummary = `[dom extraction failed: ${String(e.message || e).slice(0, 80)}]`;
  }
  let url = "";
  try {
    url = page.url();
  } catch {}
  if (domSummary.length > 6000)
    domSummary = domSummary.slice(0, 6000) + "\n[truncated]";
  return { screenshotB64, domSummary, url };
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(snapshot, account, attempt, history, stallReason, researchAppendix = "") {
  const orgHint = account.orgName
    ? `Target Claude org/workspace: ${account.orgName}`
    : "Target Claude org/workspace: Personal (default)";
  return [
    "You are an automation agent driving a Chrome browser through Google OAuth and claude.ai login.",
    `Goal: complete login as ${account.email} and reach the Claude CLI localhost callback so a refresh token is issued.`,
    orgHint,
    "",
    `Stall reason: ${stallReason}`,
    `Current URL: ${snapshot.url || "(unknown)"}`,
    "",
    "Page snapshot (DOM summary):",
    snapshot.domSummary,
    "",
    researchAppendix
      ? [
          "External research (Context7 documentation and/or web search — use to choose the action; do not paste raw URLs into your JSON):",
          researchAppendix,
          "",
        ].join("\n")
      : "",
    history.length
      ? `Previous AI-brain decisions this rotation:\n${history
          .map((h, i) => `  ${i + 1}. ${h}`)
          .join("\n")}`
      : "No prior AI-brain decisions yet.",
    "",
    `Attempt ${attempt}/${MAX_DECISIONS}.`,
    "",
    "Return ONLY one JSON object. No prose, no markdown fences.",
    'Schema: { "action": "click|fill|fill_password|goto|wait|abort", "selector"?: string, "value"?: string, "url"?: string, "reason": string }',
    "",
    "Rules:",
    "- action=click: `selector` is either a precise CSS selector or the EXACT visible text of the element.",
    "- action=fill: `selector` is a CSS selector; `value` is the literal text to type. NEVER pass a password here.",
    "- action=fill_password: the automation will inject the stored Google password into `selector` (defaults to input[type=password]).",
    "- action=goto: `url` is an absolute URL to navigate to (only for Claude or Google auth hosts).",
    "- action=wait: no fields; use when the page is still loading and a re-check is the right move.",
    "- action=abort: ONLY for dead-ends — account locked, human-only CAPTCHA, wrong account with no switch UI, subscription canceled.",
    "- Prefer the natural next step: 'Continue', 'Next', 'Authorize', 'Allow', 'Try another way', picking the target email in an account chooser, the correct workspace in the Claude org chooser.",
    "- NEVER click 'Don't allow', 'Cancel', 'Forget this device', 'Remove account', 'Delete', or any destructive option.",
    "- Language-tolerant: Dutch / German / French / Spanish variants are all valid.",
    "- reCAPTCHA/hCaptcha checkbox: try clicking once; invisible challenge → abort with reason='captcha'.",
    "- If the page is just a spinner with no interactive elements yet, action=wait.",
  ].join("\n");
}

function parseActionJson(text) {
  const raw = extractFirstJsonObject(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Public: ask Claude what to do ─────────────────────────────────────────────
export async function askAIBrain({
  page,
  account,
  history,
  stallReason,
  logger,
}) {
  const log = logger || ((m) => console.error(`[ai-brain] ${m}`));
  
  const attempt = history.length + 1;
  if (attempt > MAX_DECISIONS) {
    return { action: "abort", reason: `decision_cap_${MAX_DECISIONS}` };
  }
  const snap = await snapshotPage(page);
  const researchAppendix = await gatherResearchAppendix(
    { stallReason, url: snap.url, domSummary: snap.domSummary },
    log,
  );
  const prompt = buildPrompt(snap, account, attempt, history, stallReason, researchAppendix);

  const content = [];
  if (snap.screenshotB64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: snap.screenshotB64,
      },
    });
  }
  content.push({ type: "text", text: prompt });

  try {
    const result = await invokeBedrockConverse(toBedrockMessages([{ role: "user", content }]), log, {
      inferenceConfig: { maxTokens: 400, temperature: 0 },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (!result.ok && result.status === 0) {
      log("no AWS credentials for Bedrock — cannot run AI brain");
      return { action: "abort", reason: "no_credentials" };
    }

    if (!result.ok) {
      const data = result.data || {};
      const reason =
        data?.message || data?.error?.message || data?.error?.type || `http_${result.status}`;
      log(`bedrock error: ${String(reason).slice(0, 160)}`);
      return {
        action: "abort",
        reason: `bedrock_error: ${String(reason).slice(0, 80)}`,
      };
    }

    const text = extractBedrockText(result.data || {});

    const action = parseActionJson(text);
    if (!action?.action) {
      log(`unparseable response from bedrock: ${text.slice(0, 120)}`);
      return { action: "abort", reason: "unparseable_response" };
    }
    log(
      `decided: ${action.action}${action.selector ? ` selector=${String(action.selector).slice(0, 60)}` : ""}${action.url ? ` url=${String(action.url).slice(0, 60)}` : ""} — ${String(action.reason || "").slice(0, 80)}`,
    );
    return action;
  } catch (e) {
    log(`call failed: ${String(e.message || e).slice(0, 120)}`);
    return {
      action: "abort",
      reason: `call_failed: ${String(e.message || e).slice(0, 80)}`,
    };
  }
}

// Code-level URL allowlist — prompt constraints alone are insufficient.
const GOTO_ALLOWED_HOST_SUFFIXES = [
  "claude.ai",
  "accounts.google.com",
  "myaccount.google.com",
  "login.microsoftonline.com",
];

function isAllowedAIGotoUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  for (const suffix of GOTO_ALLOWED_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

// ── Execute the returned action against the existing driver ──────────────────
export async function executeAIAction(driver, action, { googlePassword } = {}) {
  if (!action?.action) return false;
  try {
    switch (action.action) {
      case "click": {
        if (!action.selector) return false;
        return await driver.findAndClick([action.selector]);
      }
      case "fill": {
        if (!action.selector) return false;
        return await driver.fillInput(action.selector, action.value || "");
      }
      case "fill_password": {
        if (!googlePassword) return false;
        const sel = action.selector || 'input[type="password"]';
        return await driver.fillInput(sel, googlePassword);
      }
      case "goto": {
        if (!action.url || !isAllowedAIGotoUrl(action.url)) return false;
        await driver.goto(action.url);
        return true;
      }
      case "wait": {
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export const AI_BRAIN_MAX_DECISIONS = MAX_DECISIONS;

// ── Billing-page scraper ──────────────────────────────────────────────────────
// Navigates the already-authenticated browser to console.anthropic.com/settings/billing
// and asks Claude (vision + DOM) to extract:
//   { credits_usd, auto_reload_enabled, extra_usage_enabled }
// Returns the parsed object, or null on any failure. NEVER throws.
//
// Used by rotate.mjs immediately after a successful magic-link OAuth, so the
// scrape happens on the same Chrome session that just authenticated.
export async function scrapeBillingState(page, logger) {
  const log = logger || ((m) => console.error(`[billing-scrape] ${m}`));
  if (!page) {
    log("no page handle — skipping");
    return null;
  }

  // Navigate. The driver may be Playwright Page or Kapture-popup-like; both
  // expose .goto(). Wrap each step so a single failure doesn't kill the scrape.
  try {
    if (typeof page.goto === "function") {
      await page.goto("https://console.anthropic.com/settings/billing", {
        timeout: 20_000,
      });
    } else {
      log("page has no .goto — abort");
      return null;
    }
  } catch (e) {
    log(`navigate failed: ${String(e.message || e).slice(0, 100)}`);
    return null;
  }

  // Settle. Prefer networkidle; fall back to fixed sleep.
  try {
    if (typeof page.waitForLoadState === "function") {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } else {
      await new Promise((r) => setTimeout(r, 6000));
    }
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Extra dwell — billing widget often hydrates after networkidle.
  await new Promise((r) => setTimeout(r, 2000));

  // Capture screenshot + DOM innerText (full body — credits & toggles are scattered).
  let screenshotB64 = null;
  try {
    const buf = await page.screenshot({
      type: "png",
      fullPage: true,
      timeout: 8000,
    });
    if (buf && buf.length < 1_500_000) {
      screenshotB64 = Buffer.from(buf).toString("base64");
    } else if (buf) {
      // Too big — retry with viewport only
      const viewBuf = await page
        .screenshot({ type: "png", fullPage: false, timeout: 5000 })
        .catch(() => null);
      if (viewBuf && viewBuf.length < 1_500_000) {
        screenshotB64 = Buffer.from(viewBuf).toString("base64");
      }
    }
  } catch (e) {
    log(`screenshot failed: ${String(e.message || e).slice(0, 80)}`);
  }

  let domText = "";
  try {
    domText = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return t.slice(0, 8000);
    });
  } catch {}

  if (!screenshotB64 && !domText) {
    log("no screenshot, no DOM — abort");
    return null;
  }

  const prompt = [
    "You are reading the Anthropic Console billing page (console.anthropic.com/settings/billing).",
    "Extract the current state of three things and return ONLY one JSON object — no prose, no markdown fences.",
    "",
    'Schema: { "credits_usd": number|null, "auto_reload_enabled": boolean|null, "extra_usage_enabled": boolean|null }',
    "",
    "Field meanings:",
    "- credits_usd: the prepaid API credit balance currently on the account, in US dollars. Look for labels like 'API credits', 'Credit balance', 'Prepaid credits', '$X.XX'. If multiple credit pots are shown, sum them. If unknown, return null.",
    "- auto_reload_enabled: true if the page shows that auto-reload / auto-refill / auto-top-up of credits is currently ON. false if it's OFF or shows a 'Set up auto-reload' CTA. null if undeterminable.",
    "- extra_usage_enabled: true if 'Pay-per-use' / 'Pay as you go' / 'Extra usage' / 'Overage billing' / 'Use credits beyond plan' is currently enabled (toggle ON). false if explicitly OFF. null if undeterminable.",
    "",
    "Be conservative: if you cannot read a value with high confidence, use null for that field rather than guessing.",
    "",
    "DOM TEXT (visible body, may be truncated):",
    domText || "(no DOM text captured)",
  ].join("\n");

  const content = [];
  if (screenshotB64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: screenshotB64,
      },
    });
  }
  content.push({ type: "text", text: prompt });

  try {
    const result = await invokeBedrockConverse(toBedrockMessages([{ role: "user", content }]), log, {
      inferenceConfig: { maxTokens: 400, temperature: 0 },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (!result.ok && result.status === 0) {
      log("no AWS credentials for Bedrock — skipping");
      return null;
    }

    if (!result.ok) {
      const data = result.data || {};
      const reason =
        data?.message || data?.error?.message || data?.error?.type || `http_${result.status}`;
      log(`bedrock error: ${String(reason).slice(0, 160)}`);
      return null;
    }

    const text = extractBedrockText(result.data || {});

    const parsed = parseActionJson(text);
    if (!parsed) {
      log(`unparseable response from bedrock: ${text.slice(0, 120)}`);
      return null;
    }

    // Coerce + sanity-check fields. Reject obviously-bogus shapes.
    const out = {
      credits_usd:
        typeof parsed.credits_usd === "number" && Number.isFinite(parsed.credits_usd)
          ? parsed.credits_usd
          : null,
      auto_reload_enabled:
        typeof parsed.auto_reload_enabled === "boolean"
          ? parsed.auto_reload_enabled
          : null,
      extra_usage_enabled:
        typeof parsed.extra_usage_enabled === "boolean"
          ? parsed.extra_usage_enabled
          : null,
    };
    log(
      `extracted: credits_usd=${out.credits_usd} auto_reload=${out.auto_reload_enabled} extra_usage=${out.extra_usage_enabled}`,
    );
    return out;
  } catch (e) {
    log(`call failed: ${String(e.message || e).slice(0, 120)}`);
    return null;
  }
}
