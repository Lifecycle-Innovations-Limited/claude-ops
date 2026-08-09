/** Shared single-writer gate for first-party Claude credential mutations. */
import { readDeploymentConfig, withOperationLock } from './staged-enrollment.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const capabilities = new WeakSet();
const activeWriter = new AsyncLocalStorage();

export function requireWriterCapability(capability) {
  if (!capabilities.has(capability)) throw new Error('AUTH_WRITER_CAPABILITY_REQUIRED');
}

export function withAuthWriterLock(callback, options = {}) {
  const configPath = options.configPath || process.env.CLAUDE_AUTH_COORDINATION_CONFIG;
  const existing = activeWriter.getStore();
  if (existing) {
    // AsyncLocalStorage propagates into detached descendants even after the
    // outer operation has settled. The capability is revoked at settlement,
    // so revalidate it before treating a nested call as lock ownership.
    requireWriterCapability(existing);
    return callback(existing);
  }
  if (process.platform === 'win32') throw new Error('AUTH_COORDINATION_REQUIRES_POSIX');
  if (!configPath) throw new Error('AUTH_COORDINATION_CONFIG_REQUIRED');
  if (!options.configPath && !process.env.CLAUDE_ROTATOR_CONFIG) throw new Error('CLAUDE_ROTATOR_CONFIG_REQUIRED');
  const config = readDeploymentConfig(configPath);
  if (!options.configPath) {
    const inventoryPath = resolve(process.env.CLAUDE_ROTATOR_CONFIG);
    if (realpathSync(inventoryPath) !== inventoryPath || inventoryPath !== config.runtimeInventoryPath)
      throw new Error('RUNTIME_INVENTORY_BINDING_MISMATCH');
    const inventoryDigest = createHash('sha256').update(readFileSync(inventoryPath)).digest('hex');
    if (inventoryDigest !== config.runtimeInventoryDigest) throw new Error('RUNTIME_INVENTORY_BINDING_MISMATCH');
  }
  return withOperationLock(config.operationLockPath, config.approvalKeyPath, (lock) => {
    const capability = Object.freeze({ lockNonce: lock.nonce });
    capabilities.add(capability);
    let result;
    try {
      result = activeWriter.run(capability, () => callback(capability));
    } catch (error) {
      capabilities.delete(capability);
      throw error;
    }
    let asynchronous = false;
    try {
      asynchronous = Boolean(result && typeof result.then === 'function');
    } catch (error) {
      capabilities.delete(capability);
      throw error;
    }
    if (asynchronous) return Promise.resolve(result).finally(() => capabilities.delete(capability));
    capabilities.delete(capability);
    return result;
  });
}
