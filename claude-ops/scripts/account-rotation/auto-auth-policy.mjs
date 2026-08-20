/**
 * Mac / plugin credential mutation stays fail-closed.
 * The hub CLIProxy healer is the only unattended path: CLIPROXY_HUB_HEAL=1
 * plus account.cliproxyHubHeal. Direct OAuth writers stay denied everywhere
 * (the hub binary owns refresh; the Mac is client-only).
 */
export function automatedAuthAllowed(account) {
  if (account && account.cliproxyHubHeal === true && process.env.CLIPROXY_HUB_HEAL === '1') {
    return true;
  }
  return false;
}

/** Direct OAuth writers are never authorized; identity verification is not permission. */
export function directOAuthWriterAllowed(_writer) {
  return false;
}
