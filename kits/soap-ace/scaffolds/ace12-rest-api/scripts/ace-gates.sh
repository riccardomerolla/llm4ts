#!/usr/bin/env bash
# ACE 12 gates for llm4ts epic-stories:  ace-gates.sh build | test
#
# Runs on a developer laptop with ACE 12 installed. The environment comes from
# mqsiprofile: MQSI_PROFILE names it, or ACE_HOME (default /opt/ibm/ace-12)
# locates it. Command lines follow ACE 12.0.7+ (ibmint package/deploy and
# IntegrationServer --test-project); check them against your fix pack and
# override the whole gate with LLM4TS_GATES if they differ.
set -euo pipefail

API="__API__"
PROFILE="${MQSI_PROFILE:-${ACE_HOME:-/opt/ibm/ace-12}/server/bin/mqsiprofile}"
if [ ! -f "$PROFILE" ]; then
  echo "ace-gates: mqsiprofile not found at $PROFILE (set MQSI_PROFILE or ACE_HOME)" >&2
  exit 2
fi
set +u
# shellcheck disable=SC1090
. "$PROFILE" >/dev/null
set -u

command="${1:-build}"
mkdir -p build
case "$command" in
  build)
    ibmint package --input-path . --output-bar-file "build/${API}.bar" \
      --project "$API" --project "${API}Lib" --project "${API}Policies"
    ;;
  test)
    work="build/test-work"
    rm -rf "$work"
    mqsicreateworkdir "$work" >/dev/null
    ibmint deploy --input-path . --output-work-directory "$work" \
      --project "$API" --project "${API}Lib" --project "${API}Policies" --project "${API}_Test"
    IntegrationServer --work-dir "$work" --test-project "${API}_Test" --start-msgflows false
    ;;
  *)
    echo "usage: ace-gates.sh build | test" >&2
    exit 64
    ;;
esac
