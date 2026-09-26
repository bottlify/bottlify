/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createAudioModule } from './audio/module.js';
import { createBridgeModule } from './bridge/module.js';
import { createCpuModule } from './cpu/module.js';
import { createFilesystemModule } from './filesystem/module.js';
import { createGraphicsModule } from './graphics/module.js';
import { createInputModule } from './input/module.js';
import { createKernelModule } from './kernel/module.js';
import { createLoaderModule } from './loader/module.js';
import { createLogModule } from './log/module.js';
import { createMediaModule } from './media/module.js';
import { createMemoryModule } from './memory/module.js';
import { createWin32Module } from './win32/module.js';

/**
 * Default module set of the package, made for one graph.
 *
 * A module keeps the instance it made so its `diagnostics()` and `dispose()`
 * can reach it, and more than one graph lives in a realm: a child started
 * beside its parent is built while the parent stands and disposed while it
 * goes on. Each call therefore makes module objects of its own, and a child's
 * going cannot empty its parent's report or take away what the parent's own
 * dispose has to release.
 *
 * @returns {import("../system/contract.js").BottlifyModule[]}
 */
export function defaultModules(){
    return [
        createLogModule(),
        createCpuModule(),
        createMemoryModule(),
        createKernelModule(),
        createBridgeModule(),
        createLoaderModule(),
        createFilesystemModule(),
        createMediaModule(),
        createWin32Module(),
        createGraphicsModule(),
        createAudioModule(),
        createInputModule(),
    ];
}
