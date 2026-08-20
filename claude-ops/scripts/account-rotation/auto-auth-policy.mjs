/**
 * Mac / plugin credential mutation stays fail-closed.
 * The hub CLIProxy healer is the only unattended path, gated by two
 * factors on genuinely different control planes: CLIPROXY_HUB_HEAL=1
 * ("this process is allowed to mutate credentials at all", a process
 * environment variable — settable by anyone who can edit the systemd
 * unit's Environment= lines or export it in a shell) and
 * account.cliproxyHubHeal ("this host was deliberately provisioned for
 * unattended healing", a filesystem fact — cliproxy-heal-tick.mjs derives
 * it from a marker file at a FIXED path (CLIPROXY_ROOT + '/.heal-account-optin',
 * not itself overridable by any env var) whose CONTENT must equal a fixed
 * expected token, not merely exist. Content-gating (rather than
 * existence-gating) is what makes this a real second factor: existence-only
 * would let an Environment=-only change point at any file that already
 * exists on the host (e.g. /etc/hosts) and satisfy the gate without ever
 * running install-heal.sh. Only install-heal.sh writes that exact token, so
 * a single environment flip cannot forge the second factor — it genuinely
 * requires an install-time step against /opt/crsproxy. Direct OAuth writers
 * stay denied everywhere (the hub binary owns refresh; the Mac is
 * client-only).
 */
/**
 * Expected content of the unattended-healing opt-in marker file. install-heal.sh
 * is the only writer; cliproxy-heal-tick.mjs reads it back and treats the
 * marker as absent unless the content matches exactly (see this file's
 * top-of-file comment for why content, not mere existence, is required).
 * Bump the suffix if the marker's meaning ever changes, so a stale marker
 * left over from an older install cannot silently opt a host back in.
 */
export const CLIPROXY_HEAL_OPTIN_TOKEN = 'cliproxy-heal-optin-v1';

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
