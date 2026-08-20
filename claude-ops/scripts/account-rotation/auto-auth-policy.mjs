/**
 * Mac / plugin credential mutation stays fail-closed.
 * The hub CLIProxy healer is the only unattended path, gated by two
 * factors on genuinely different control planes: CLIPROXY_HUB_HEAL=1
 * ("this process is allowed to mutate credentials at all", a process
 * environment variable — settable by anyone who can edit the systemd
 * unit's Environment= lines or export it in a shell) and
 * account.cliproxyHubHeal ("this host was deliberately provisioned for
 * unattended healing", a filesystem fact — cliproxy-heal-tick.mjs derives
 * it from the presence of the marker file that only install-heal.sh
 * writes, at CLIPROXY_HEAL_ACCOUNT_OPTIN_MARKER). Editing the unit's
 * Environment= lines (or exporting the env var in a shell) alone cannot
 * produce the marker file, so a single environment flip cannot satisfy
 * both factors — the second requires an install-time step against
 * /opt/crsproxy. Direct OAuth writers stay denied everywhere (the hub
 * binary owns refresh; the Mac is client-only).
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
