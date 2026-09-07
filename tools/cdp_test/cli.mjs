/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { runProbeAndExit } from './probe.mjs';

const [, , command] = process.argv;

switch (command){
    case 'probe': {
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
