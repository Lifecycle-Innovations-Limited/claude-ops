#!/usr/bin/env bash
# Regressietest voor het echte defect: ops-inbox-scan stierf onder `set -euo pipefail`
# wanneer een waarde-vlag (--days, --email-query, --email-max, --gmail-account,
# --wa-store, --bridge-port, --peer-store) als LAATSTE CLI-argument stond, zonder
# waarde erna.
#
# Oorzaak: de case-tak deed `shift` om de waarde weg te schuiven, en de lus deed
# daarna NOG een `shift` voor de vlag zelf. Als $# na de eerste shift al 0 was,
# faalde de tweede shift ("shift count out of range", exit 1) en `set -e` liet het
# hele script fataal sterven — zonder enige foutmelding op stderr. Dit gebeurde
# lang voordat de embedded Python op regel ~135 draait; die regel was symptoom,
# niet oorzaak.
#
# We isoleren alleen het argument-parse-gedrag (geen echte WhatsApp/Gmail-scan
# nodig): met -h/--help is de rest van het script een no-op zodra de parse-lus
# voltooid is, dus een geslaagde parse eindigt met exit 0 en de help-tekst.
#
# Run: bash claude-ops/tests/test-ops-inbox-scan-arg-parse.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN="${OPS_INBOX_SCAN:-$HERE/../bin/ops-inbox-scan}"

fail=0
chk() {
  # $1=label $2=actual_exit $3=expected_exit
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 (exit=$2)"
  else
    echo "  FAIL $1: got exit=$2, expected exit=$3"
    fail=$((fail + 1))
  fi
}

echo "1. value-flags as the LAST arg (no value follows) must fail LOUDLY (exit 2), not"
echo "   die silently on an internal 'shift count out of range' (exit 1, no stderr)"
for flag in --days --email-query --email-max --gmail-account --wa-store --bridge-port --peer-store; do
  out="$(bash "$SCAN" --whatsapp-only --email-only "$flag" 2>&1)"
  rc=$?
  # --wa-store/--bridge-port additionally require each other, so they may exit 2
  # earlier for a different, already-correct reason; any clean 2 is acceptable.
  chk "'$flag' as the last, valueless arg" "$rc" "2"
  case "$out" in
    *"unbound variable"*|*"shift count out of range"*)
      echo "  FAIL $flag: raw shell error leaked to output: $out"
      fail=$((fail + 1))
      ;;
  esac
  case "$out" in
    *"requires a value"*|*"cannot be combined"*) : ;;
    *) echo "  FAIL $flag: no explanatory error message (got: $out)"; fail=$((fail + 1)) ;;
  esac
done

echo "2. a genuinely missing value at end of argv must fail LOUDLY, not silently die"
out="$(bash "$SCAN" --days 2>&1)"
rc=$?
chk "'--days' alone (no value, no other args)" "$rc" "2"
case "$out" in
  *"requires a value"*) echo "  ok   error message names the missing value" ;;
  *) echo "  FAIL error message does not explain the missing value: $out"; fail=$((fail + 1)) ;;
esac

echo "3. normal usage still works (no regression on the happy path)"
out="$(bash "$SCAN" --days 3 --help 2>&1)"
rc=$?
chk "'--days 3 --help'" "$rc" "0"

echo
[ "$fail" -eq 0 ] && echo "ALL GOOD" || echo "$fail FAIL"
exit "$fail"
