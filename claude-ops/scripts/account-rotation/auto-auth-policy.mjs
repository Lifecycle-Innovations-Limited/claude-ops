/** Configuration alone is never a signed, exact mutation authorization. */
export function automatedAuthAllowed(_account) {
  return false;
}

/** Direct OAuth writers are never authorized; identity verification is not permission. */
export function directOAuthWriterAllowed(_writer) {
  return false;
}
