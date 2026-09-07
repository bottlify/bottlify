/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * input layer -- keyboard, mouse, gamepad, DirectInput. Dependency module.
 *
 * Requires: win32, bridge, memory.
 *
 * What it promises:
 * - `send(event)`   one normalised host event becomes a window message and a
 *                   change of DirectInput state.
 * - `post(event)`   one event in a DirectInput device's own codes.
 * - `attach(canvas)` listens to a viewport and produces those events; `detach`
 *                   stops, `poll` reads what has no events of its own.
 * - `libraries()`   DINPUT.dll and DINPUT8.dll, for the loader.
 * - `keyState(vk)`, `cursor()`, `pad()`  what is held right now.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 * @typedef {import("./router.js").HostInputEvent} HostInputEvent
 */
