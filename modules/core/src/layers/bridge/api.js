/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * bridge layer — call bridge from guest code into our code and back.
 *
 * Responsibilities (master plan §8.4): traps, marshalling (cdecl/stdcall/thiscall),
 * callbacks into the guest, async operations with correct thread parking.
 * Requires: cpu, kernel, log. Phase 0: stub.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
