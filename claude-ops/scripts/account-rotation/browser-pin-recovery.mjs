import { existsSync } from 'node:fs';

// Browser-pin setup is a legacy direct credential mutation path. There is no
// portable filesystem compare-and-swap that can prove a nonparticipating
// writer did not replace the destination between validation and rename. Keep
// both publication and restoration fail closed until they use the signed
// staged-enrollment writer protocol end to end.
export function applyBrowserPinTransaction() {
  throw new Error('BROWSER_PIN_MUTATION_DISABLED');
}

export function createBrowserPinBackup() {
  throw new Error('BROWSER_PIN_MUTATION_DISABLED');
}

export function recordBrowserPinExpectedPost() {
  throw new Error('BROWSER_PIN_MUTATION_DISABLED');
}

export function restoreBrowserPinBackup({ sentinelPath } = {}) {
  return {
    restored: false,
    reason: 'browser-pin-mutation-disabled',
    retained: typeof sentinelPath === 'string' && existsSync(sentinelPath),
  };
}
