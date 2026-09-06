/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { runProbeAndExit } from "./probe.mjs";

const [, , command] = process.argv;

switch (command) {
  case "probe": {
    const code = await runProbeAndExit();
    process.exit(code);
    break;
  }
  default: {
    console.error(`Usage: cdp_test <command>
  probe   run the acceptance probe (browser → worker ping → screenshot)`);
    process.exit(1);
  }
}