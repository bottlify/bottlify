/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
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
