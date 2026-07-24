#!/usr/bin/env node
/**
 * Per-account single-writer OAuth refresh lock.
 *
 * The local lock is atomic and a live holder is never evicted because of age.
 * The fleet Redis lock is mandatory unless the explicit test-only local mode is
 * selected. Refresh tokens are single-use, so uncertainty must fail closed.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR =
  process.env.CRS_REFRESH_LOCK_DIR ||
  join(process.env.HOME || '', '.claude', 'scripts', 'account-rotation', '.crs-refresh-locks');
const TTL_SEC = Number(process.env.CRS_REFRESH_LOCK_TTL_SEC || 120);
const SSH_HOST = process.env.CRS_SSH_HOST || 'dev-us';
const LOCAL_REDIS = process.env.CRS_REDIS_URL || '';

export function lockOwner() {
  return `${hostname()}:${process.pid}`;
}

function localLockPath(accountKey) {
  return join(LOCK_DIR, `${String(accountKey).replace(/[^a-zA-Z0-9@._-]/g, '_')}.lock`);
}

function parseOwner(raw) {
  const value = String(raw || '').trim();
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const ownerHost = value.slice(0, separator);
  const ownerPid = Number(value.slice(separator + 1));
  if (!ownerHost || !Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  return { ownerHost, ownerPid };
}

function ownerAlive(owner) {
  if (!owner || owner.ownerHost !== hostname()) return null;
  try {
    process.kill(owner.ownerPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH' ? false : null;
  }
}

function tryLocalAcquire(accountKey) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = localLockPath(accountKey);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, lockOwner());
      closeSync(fd);
      return true;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (error?.code !== 'EEXIST') return false;
      // Open once and read via the fd rather than readFileSync(lockPath) — a
      // path-based read could observe a different file than the one that
      // caused EEXIST if the holder released/renewed it in between.
      let owner;
      let readFd;
      try {
        readFd = openSync(lockPath, 'r');
        owner = parseOwner(readFileSync(readFd, 'utf8'));
      } catch {
        return false;
      } finally {
        if (readFd !== undefined) {
          try {
            closeSync(readFd);
          } catch {}
        }
      }
      const alive = ownerAlive(owner);
      if (alive === true || alive === null) return false;
      try {
        rmSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLocal(accountKey) {
  // No existsSync pre-check — open directly and let a missing file throw
  // ENOENT like any other failure, rather than checking-then-opening a path.
  const lockPath = localLockPath(accountKey);
  let fd;
  try {
    fd = openSync(lockPath, 'r');
    if (readFileSync(fd, 'utf8').trim() === lockOwner()) {
      rmSync(lockPath);
    }
  } catch {
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function redisAuthChecked(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/NOAUTH|WRONGPASS|invalid username-password pair/i.test(output)) {
    return { ...result, status: 42 };
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function redisCmd(args) {
  if (LOCAL_REDIS) {
    return redisAuthChecked(
      spawnSync('redis-cli', ['-u', LOCAL_REDIS, ...args], {
        encoding: 'utf8',
        timeout: 5000,
      }),
    );
  }
  const redisArgs = args.map(shellQuote).join(' ');
  const remote = [
    'password=$(',
    '  for container in crs-redis-1 crs-claude-relay-1; do',
    '    docker inspect "\$container" --format \'{{range .Config.Env}}{{println .}}{{end}}\' 2>/dev/null',
    "  done | sed -n 's/^REDIS_PASSWORD=//p' | head -1",
    ')',
    'if [ -z "$password" ]; then echo "remote redis password unavailable" >&2; exit 41; fi',
    `output=$(docker exec crs-redis-1 redis-cli -a "$password" --no-auth-warning ${redisArgs} 2>&1)`,
    'status=$?',
    'case "$output" in *NOAUTH*|*WRONGPASS*|*"invalid username-password pair"*) echo "remote redis authentication failed" >&2; exit 42;; esac',
    'printf "%s\n" "$output"',
    'exit "$status"',
  ].join('\n');
  return redisAuthChecked(
    spawnSync('ssh', ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', SSH_HOST, remote], {
      encoding: 'utf8',
      timeout: 10_000,
    }),
  );
}

export function acquireRefreshLock(accountKey) {
  if (!tryLocalAcquire(accountKey)) return null;
  const key = `crs:refresh-lock:${accountKey}`;
  const value = lockOwner();

  if (process.env.CRS_REFRESH_LOCK_LOCAL_ONLY === '1' && process.env.CRS_REFRESH_LOCK_TEST_MODE === '1') {
    return () => releaseLocal(accountKey);
  }

  const result = redisCmd(['SET', key, value, 'NX', 'EX', String(TTL_SEC)]);
  if (process.env.CRS_REFRESH_LOCK_DEBUG === '1') {
    console.error(`[refresh-lock] redis status=${result.status} signal=${result.signal || ''}`);
  }
  if (result.status === 0 && String(result.stdout || '').trim() === 'OK') {
    return () => {
      redisCmd([
        'EVAL',
        'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',
        '1',
        key,
        value,
      ]);
      releaseLocal(accountKey);
    };
  }

  releaseLocal(accountKey);
  return null;
}
