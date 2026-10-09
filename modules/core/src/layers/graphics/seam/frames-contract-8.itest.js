/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** The frames gate (`frames-contract.itest.js`) for Direct3D 8. */

import { D3D8 } from './guest-machine.itest.js';
import { frameGate } from './frames-contract.itest.js';

frameGate(D3D8);
