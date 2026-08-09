/** Automated authentication is denied when an account opts out, regardless of filters. */
export function automatedAuthAllowed(account) {
  return account?.autoAuthDisabled !== true;
}
