/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { audioModule } from "./audio/module.js";
import { bridgeModule } from "./bridge/module.js";
import { cpuModule } from "./cpu/module.js";
import { filesystemModule } from "./filesystem/module.js";
import { graphicsModule } from "./graphics/module.js";
import { inputModule } from "./input/module.js";
import { kernelModule } from "./kernel/module.js";
import { loaderModule } from "./loader/module.js";
import { logModule } from "./log/module.js";
import { memoryModule } from "./memory/module.js";
import { win32Module } from "./win32/module.js";

/**
 * Default module set of the package.
 *
 * @returns {import("../system/contract.js").BottlifyModule[]}
 */
export function defaultModules() {
    return [
        logModule,
        cpuModule,
        memoryModule,
        kernelModule,
        bridgeModule,
        loaderModule,
        filesystemModule,
        win32Module,
        graphicsModule,
        audioModule,
        inputModule,
    ];
}