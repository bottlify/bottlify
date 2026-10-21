/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** The ring made ahead (`frames-contract.itest.js` `drainGate`) for Direct3D 9. */

import { D3D9 } from './guest-machine.itest.js';
import { drainGate } from './frames-contract.itest.js';

drainGate(D3D9);
