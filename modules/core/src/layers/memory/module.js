/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { createStubModule } from "../../system/stub.js";

/** @type {import("../../system/contract.js").BottlifyModule} */
export const memoryModule = createStubModule("memory", "0.0.0", ["cpu"]);