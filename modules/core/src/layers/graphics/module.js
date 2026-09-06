/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createStubModule } from '../../system/stub.js';

/** @type {import("../../system/contract.js").BottlifyModule} */
export const graphicsModule = createStubModule('graphics', '0.0.0', ['win32', 'bridge', 'memory']);
