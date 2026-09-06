/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { createStubModule } from '../../system/stub.js';

/** @type {import("../../system/contract.js").BottlifyModule} */
export const audioModule = createStubModule('audio', '0.0.0', ['win32', 'bridge', 'memory']);
