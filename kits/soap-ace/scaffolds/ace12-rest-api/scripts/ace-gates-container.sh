#!/usr/bin/env bash
# The same gates inside the ACE container image, for machines without a local
# ACE install:  ace-gates-container.sh build | test
# ACE_IMAGE names the image your organisation uses (entitled registries need a login).
set -euo pipefail
image="${ACE_IMAGE:?set ACE_IMAGE to your ACE 12 image}"
exec docker run --rm -e LICENSE=accept -e MQSI_PROFILE=/opt/ibm/ace-12/server/bin/mqsiprofile \
  -v "$PWD":/work -w /work --entrypoint bash "$image" scripts/ace-gates.sh "${1:-build}"
