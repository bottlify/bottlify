/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * kernel layer — guest execution: threads, scheduler, time, synchronization, handles.
 *
 * Responsibilities (master plan §8.3): one context switch point, quantum measured
 * in executed instructions, preservation of all shared CPU state.
 * Requires: cpu, memory, log. Phase 0: stub.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
