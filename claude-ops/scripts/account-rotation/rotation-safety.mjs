#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

const MIN_FRESH_TOKEN_TTL_MS = 5 * 60_000;

export class RotationSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RotationSafetyError';
    this.code = code;
  }
}

export function safeUrlLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '[empty-url]';
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}/[redacted]`;
  } catch {
    return '[redacted-url]';
  }
}

export function redactSensitiveText(value) {
  let text = String(value ?? '');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(
    /\b(access[_-]?token|refresh[_-]?token|authorization)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
    '$1=[REDACTED]',
  );
  text = text.replace(/\b((?:verification\s+)?code\s*[:=]?\s*)(\d{6})\b/gi, '$1[REDACTED]');
  text = text.replace(/\bcode:(\d{6})\b/gi, 'code:[REDACTED]');
  text = text.replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => safeUrlLabel(url));
  return text;
}

function oauthEnvelope(tokenJson) {
  try {
    const parsed = typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson;
    const oauth = parsed?.claudeAiOauth || parsed;
    if (!oauth || typeof oauth !== 'object') return null;
    const accessToken = String(oauth.accessToken || '');
    const refreshToken = String(oauth.refreshToken || '');
    const rawExpiry = oauth.expiresAt ?? oauth.expires_at ?? 0;
    const numericExpiry = Number(rawExpiry);
    const expiresAt = Number.isFinite(numericExpiry) ? numericExpiry : new Date(rawExpiry).getTime();
    if (!accessToken) return null;
    return { accessToken, refreshToken, expiresAt };
  } catch {
    return null;
  }
}

export function tokenSnapshot(tokenJson) {
  const oauth = oauthEnvelope(tokenJson);
  if (!oauth) return null;
  return {
    // Not a password hash — this is a content fingerprint used only to detect
    // whether the vault's token pair changed between two reads (see
    // evaluateFreshToken below). SHA-256 is the right tool for that; a slow
    // KDF (bcrypt/scrypt/argon2) would add latency for zero security benefit
    // since nothing here verifies a credential against a stored hash.
    // codeql[js/insufficient-password-hash]
    fingerprint: createHash('sha256').update(oauth.accessToken).update('\0').update(oauth.refreshToken).digest('hex'),
    expiresAt: oauth.expiresAt,
  };
}

export function evaluateFreshToken(before, after, options = {}) {
  const now = Number(options.now ?? Date.now());
  const minTtlMs = Number(options.minTtlMs ?? MIN_FRESH_TOKEN_TTL_MS);
  const previous = before?.fingerprint ? before : tokenSnapshot(before);
  const candidate = after?.fingerprint ? after : tokenSnapshot(after);

  if (!candidate?.fingerprint) return { ok: false, reason: 'missing-token' };
  if (!Number.isFinite(candidate.expiresAt)) return { ok: false, reason: 'missing-expiry' };
  if (candidate.expiresAt < now + minTtlMs) return { ok: false, reason: 'token-not-fresh' };
  if (previous?.fingerprint === candidate.fingerprint) return { ok: false, reason: 'token-unchanged' };
  return { ok: true, reason: 'fresh-token' };
}

export function createDeadline(totalMs, options = {}) {
  const duration = Number(totalMs);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RotationSafetyError('INVALID_DEADLINE', 'Rotation deadline must be a positive number');
  }
  const now = options.now || Date.now;
  const expiresAt = now() + duration;
  return {
    expiresAt,
    remaining() {
      return Math.max(0, expiresAt - now());
    },
    budget(phase, requestedMs) {
      const remaining = Math.max(0, expiresAt - now());
      if (remaining <= 0) {
        throw new RotationSafetyError('ROTATION_DEADLINE_EXCEEDED', `Rotation deadline exhausted before ${phase}`);
      }
      return Math.max(1, Math.min(remaining, Number(requestedMs) || remaining));
    },
  };
}

export async function withDeadline(factory, deadline, phase, requestedMs, options = {}) {
  const timeoutMs = deadline.budget(phase, requestedMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try {
            options.onTimeout?.();
          } catch {}
          reject(
            new RotationSafetyError(
              'ROTATION_DEADLINE_EXCEEDED',
              `Rotation phase ${phase} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function classifyGogFailure(value) {
  const message = String(value || '');
  if (/timed?\s*out|ETIMEDOUT/i.test(message)) return 'GOG_PREFLIGHT_TIMEOUT';
  if (/no tty|not a tty|inappropriate ioctl|cannot prompt|non.?interactive/i.test(message)) {
    return 'GOG_KEYRING_NONINTERACTIVE';
  }
  if (/keyring|keychain|password|secret service/i.test(message)) return 'GOG_KEYRING_UNAVAILABLE';
  if (/unauthorized|invalid_grant|no auth|login required|token.*expired/i.test(message)) {
    return 'GOG_AUTH_UNAVAILABLE';
  }
  return 'GOG_PREFLIGHT_FAILED';
}

export function preflightGogInbox(options) {
  const inbox = String(options?.inbox || '').trim();
  const env = options?.env || process.env;
  const headless = options?.headless === true;
  const run = options?.run || execFileSync;
  const timeoutMs = Number(options?.timeoutMs || 10_000);
  const backend = String(env.GOG_KEYRING_BACKEND || '')
    .trim()
    .toLowerCase();

  if (!inbox) {
    throw new RotationSafetyError('GOG_INBOX_MISSING', 'Magic-link inbox is not configured');
  }
  if (headless && ['file', 'json'].includes(backend) && !env.GOG_KEYRING_PASSWORD) {
    throw new RotationSafetyError(
      'GOG_KEYRING_PASSWORD_MISSING',
      'Headless gog keyring password is unavailable; refusing to prompt or invent credentials',
    );
  }

  try {
    run('gog', ['gmail', 'search', 'newer_than:1d from:anthropic.com', '--max', '1', '-j', '--account', inbox], {
      timeout: timeoutMs,
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    });
  } catch (error) {
    const raw = error?.stderr?.toString?.() || error?.message || error;
    const code = classifyGogFailure(raw);
    const detail = redactSensitiveText(raw).split('\n')[0].slice(0, 180);
    throw new RotationSafetyError(code, `Magic-link inbox preflight failed: ${detail}`);
  }
  return true;
}

function parseLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      host: String(parsed.host || ''),
      startedAt: Number(parsed.startedAt || 0),
    };
  } catch {
    const [timestamp, pidText] = String(raw || '')
      .trim()
      .split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      host: hostname(),
      startedAt: new Date(timestamp).getTime() || 0,
    };
  }
}

function processAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function acquireProcessLock(lockPath, options = {}) {
  const pid = Number(options.pid || process.pid);
  const host = String(options.host || hostname());
  const now = options.now || Date.now;
  const kill = options.kill || process.kill;
  const log = options.log || (() => {});
  const owner = { version: 1, pid, host, startedAt: now() };
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      closeSync(fd);
      fd = undefined;
      return () => {
        let releaseFd;
        try {
          releaseFd = openSync(lockPath, 'r');
          const current = parseLock(readFileSync(releaseFd, 'utf8'));
          if (current?.pid === pid && current?.host === host) rmSync(lockPath);
        } catch {
        } finally {
          if (releaseFd !== undefined) {
            try {
              closeSync(releaseFd);
            } catch {}
          }
        }
      };
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (error?.code !== 'EEXIST') return null;
      // Open once and read via the fd — a path-based readFileSync could
      // observe a different file than the one that caused EEXIST if the
      // holder released/renewed the lock in between.
      let current;
      let readFd;
      try {
        readFd = openSync(lockPath, 'r');
        current = parseLock(readFileSync(readFd, 'utf8'));
      } catch {
        return null;
      } finally {
        if (readFd !== undefined) {
          try {
            closeSync(readFd);
          } catch {}
        }
      }
      if (!current) return null;
      if (current.host !== host || processAlive(current.pid, kill)) {
        const ageSeconds = Math.max(0, Math.round((now() - current.startedAt) / 1000));
        log(`Rotation lock held by live PID ${current.pid} (${ageSeconds}s old)`);
        return null;
      }
      try {
        rmSync(lockPath);
      } catch {
        return null;
      }
      log(`Removed dead rotation lock for PID ${current.pid}`);
    }
  }
  return null;
}
