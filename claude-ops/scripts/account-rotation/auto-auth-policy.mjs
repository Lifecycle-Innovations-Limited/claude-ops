/**
 * Mac / plugin credential mutation stays fail-closed.
 * The hub CLIProxy healer is the only unattended path, gated by two
 * independent factors: CLIPROXY_HUB_HEAL=1 ("this process is allowed to
 * mutate credentials at all") and account.cliproxyHubHeal ("this call site
 * was explicitly provisioned for unattended healing"). cliproxy-heal-tick.mjs
 * derives the second factor from CLIPROXY_HEAL_ACCOUNT_OPTIN, which is set
 * only by the generated systemd unit (templates/cliproxy-heal.service) — not
 * simply by exporting CLIPROXY_HUB_HEAL — so a caller cannot satisfy both
 * factors with a single environment flip. Direct OAuth writers stay denied
 * everywhere (the hub binary owns refresh; the Mac is client-only).
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
