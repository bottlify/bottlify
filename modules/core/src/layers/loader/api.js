/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
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