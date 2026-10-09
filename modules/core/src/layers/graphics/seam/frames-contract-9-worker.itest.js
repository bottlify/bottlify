/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** The frames gate (`frames-contract.itest.js`) for Direct3D 9: the device recording for a graphics worker against the device drawing itself. */

import { D3D9 } from './guest-machine.itest.js';
import { frameGate } from './frames-contract.itest.js';

frameGate(D3D9, 'worker');
