/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * loader layer — PE images.
 *
 * Responsibilities (master plan §8.5): headers, sections, relocations, imports,
 * TLS, exceptions, in-guest module synthesis with a real export table.
 * Requires: cpu, memory, log. Phase 0: stub.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
