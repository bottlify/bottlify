/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * bridge layer — call bridge from guest code into our code and back.
 *
 * Responsibilities (master plan §8.4): traps, marshalling (cdecl/stdcall/thiscall),
 * callbacks into the guest, async operations with correct thread parking.
 * Requires: cpu, kernel, memory, log.
 *
 * Surface:
 * - `Convention` — stdcall, cdecl, thiscall.
 * - `register(name, { convention, argBytes, handler })` → the guest address that
 *   calls the handler. `argBytes` is the size of the argument list, `this`
 *   included; what the callee pops follows from the convention.
 * - `park(thread?)` → the token a handler returns instead of an answer, having
 *   parked the caller. Nothing else produces one (§12.3).
 * - `calls()` — the imports the guest has called, in order.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
