/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cpu layer — guest execution, on the engine a launch selects: cork, loaded by
 * URL, or the v86 emulator a caller brought.
 *
 * Responsibilities: run a quantum, stop, registers, breakpoints, physical
 * memory read/write.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
