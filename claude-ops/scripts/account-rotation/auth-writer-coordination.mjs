/** Shared single-writer gate for first-party Claude credential mutations. */
import { readDeploymentConfig, withOperationLock } from './staged-enrollment.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const capabilities = new WeakSet();
const activeWriter = new AsyncLocalStorage();

export function requireWriterCapability(capability) {
  if (!capabilities.has(capability)) throw new Error('AUTH_WRITER_CAPABILITY_REQUIRED');
}

export function withAuthWriterLock(callback, { configPath = process.env.CLAUDE_AUTH_COORDINATION_CONFIG } = {}) {
  const existing = activeWriter.getStore();
  if (existing) return callback(existing);
  if (process.platform === 'win32') throw new Error('AUTH_COORDINATION_REQUIRES_POSIX');
  if (!configPath) throw new Error('AUTH_COORDINATION_CONFIG_REQUIRED');
  const config = readDeploymentConfig(configPath);
  return withOperationLock(config.operationLockPath, config.approvalKeyPath, (lock) => {
    const capability = Object.freeze({ lockNonce: lock.nonce });
    capabilities.add(capability);
    return activeWriter.run(capability, () => callback(capability));
  });
}
