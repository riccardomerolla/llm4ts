#!/usr/bin/env node
// Smoke check for the legacy J2EE fixture seed script. Deterministic and
// network-free: seeds into a temp directory, asserts the produced git repo
// contains the expected file set, and cleans up.
//
//   node examples/demo-bank/smoke-legacy-j2ee.mjs

import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const seedScript = path.join(scriptDir, "seed-legacy-j2ee.mjs")

const WEBAPP = "src/main/webapp"
const JAVA = "src/main/java/com/demobank/legacy"

// Explicit answer-key file list (relative to the seeded repo root).
const expectedFiles = [
  "PAGES.md",
  "pom.xml",
  // shared shell
  `${WEBAPP}/WEB-INF/web.xml`,
  `${WEBAPP}/header.jsp`,
  `${WEBAPP}/footer.jsp`,
  `${WEBAPP}/nav.jsp`,
  `${WEBAPP}/js/jquery-1.12.4.min.js`,
  `${WEBAPP}/js/validate.js`,
  `${WEBAPP}/css/bank.css`,
  // hero 1: account overview
  `${WEBAPP}/accountOverview.jsp`,
  `${JAVA}/web/AccountOverviewServlet.java`,
  `${JAVA}/dto/AcctOvwDTO.java`,
  `${JAVA}/esb/EsbAcctListService.java`,
  // hero 2: beneficiary management
  `${WEBAPP}/beneficiaryList.jsp`,
  `${WEBAPP}/beneficiaryEdit.jsp`,
  `${JAVA}/web/BeneficiaryServlet.java`,
  `${JAVA}/dto/BenfDTO.java`,
  `${JAVA}/esb/EsbBenfListService.java`,
  `${JAVA}/esb/EsbBenfMaintService.java`,
  // hero 3: wire transfer
  `${WEBAPP}/transferStep1.jsp`,
  `${WEBAPP}/transferStep2.jsp`,
  `${WEBAPP}/transferConfirm.jsp`,
  `${JAVA}/web/TransferServlet.java`,
  `${JAVA}/web/TransferDraft.java`,
  `${JAVA}/dto/TrfDTO.java`,
  `${JAVA}/esb/EsbTrfValidateService.java`,
  `${JAVA}/esb/EsbTrfExecService.java`,
  // esb plumbing
  `${JAVA}/esb/EsbGateway.java`,
  `${JAVA}/esb/EsbException.java`,
  // filler pages
  `${WEBAPP}/login.jsp`,
  `${WEBAPP}/dashboard.jsp`,
  `${WEBAPP}/settings.jsp`,
  `${WEBAPP}/help.jsp`,
  `${WEBAPP}/messages.jsp`,
  `${WEBAPP}/profile.jsp`,
  // dead pages (unreferenced from nav/web.xml, but must exist)
  `${WEBAPP}/oldTransfer.jsp`,
  `${WEBAPP}/promoQ3.jsp`,
  `${WEBAPP}/testHarness.jsp`
]

let tempRoot
const failures = []
try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "demo-bank-smoke-"))
  const repoDir = path.join(tempRoot, "legacy-j2ee")

  const seed = spawnSync(process.execPath, [seedScript, repoDir], {
    encoding: "utf8"
  })
  if (seed.status !== 0) {
    console.error("seed script failed:")
    console.error(seed.stdout)
    console.error(seed.stderr)
    process.exit(1)
  }
  const printed = seed.stdout.trim().split("\n").pop()
  if (printed !== repoDir) {
    failures.push(`seed script printed "${printed}", expected "${repoDir}"`)
  }

  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    failures.push("seeded target is not a git repository (.git missing)")
  } else {
    const head = execFileSync("git", ["-C", repoDir, "log", "--format=%an <%ae> %aI", "-1"], {
      encoding: "utf8"
    }).trim()
    if (!head.startsWith("Demo Bank <demo@example.invalid> 2020-01-01")) {
      failures.push(`unexpected commit identity/date: ${head}`)
    }
    const dirty = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], {
      encoding: "utf8"
    }).trim()
    if (dirty.length > 0) {
      failures.push(`seeded repo has uncommitted files:\n${dirty}`)
    }
  }

  for (const rel of expectedFiles) {
    const abs = path.join(repoDir, rel)
    if (!fs.existsSync(abs)) {
      failures.push(`missing expected file: ${rel}`)
    } else if (fs.statSync(abs).size === 0) {
      failures.push(`expected file is empty: ${rel}`)
    }
  }

  // Overwrite guard: re-seeding the same non-empty target must fail...
  const second = spawnSync(process.execPath, [seedScript, repoDir], {
    encoding: "utf8"
  })
  if (second.status === 0) {
    failures.push("seed script overwrote a non-empty target without --force")
  }
  // ...and succeed with --force.
  const forced = spawnSync(process.execPath, [seedScript, repoDir, "--force"], {
    encoding: "utf8"
  })
  if (forced.status !== 0) {
    failures.push(`seed script --force failed: ${forced.stderr}`)
  }
} finally {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error("legacy-j2ee smoke FAILED:")
  for (const f of failures) {
    console.error(`  - ${f}`)
  }
  process.exit(1)
}

console.log(`legacy-j2ee smoke OK: ${expectedFiles.length} files verified in seeded git repo`)
