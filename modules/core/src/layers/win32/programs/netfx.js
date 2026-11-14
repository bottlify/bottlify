/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The .NET Framework 4's setup a program brings (`dotNetFx40_Full_x86_x64.exe`,
 * `ndp48-x86-x64-allos-enu.exe`, a 4.5 to 4.8 web installer), run by the engine
 * in place of the copy.
 *
 * The Framework is a layer here, built once and shared by every bottle
 * (`roadmap/dotnet-layer.md`), not a copy each bottle's installation makes:
 * a bottle carries it only as the layer mounted under it. So the setup asks the
 * embedder for that layer where the machine has no Framework 4 (`layer-needed`)
 * and answers as a setup that found the Framework installed: it succeeds, shows
 * nothing and asks for no restart (A248). A program the installation goes on
 * to start finds the Framework from the bottle's next start on.
 *
 * Everything goes through this process's own exports, like any other
 * program's work.
 */

import { FRAMEWORK_LAYERS } from '../mscoree/need.js';
import { FRAMEWORK_V4, SHIM_IMPLEMENTATION } from '../mscoree/functions.js';

const MAX_PATH = 260;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const PROCESSOR_ARCHITECTURE_AMD64 = 9;

/** The setup's exit code with nothing left to do and no restart. */
export const NETFX_SUCCESS = 0;

/**
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runFrameworkSetup(context){
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>context.call('KERNEL32.dll', name, args);
    const info = context.block(36);
    await kernel32('GetNativeSystemInfo', [info]);
    const architecture = context.read(info, 2);
    const wide = (architecture[0] | architecture[1] << 8) === PROCESSOR_ARCHITECTURE_AMD64;

    const folder = context.block(MAX_PATH * 2);
    const length = await kernel32('GetWindowsDirectoryW', [folder, MAX_PATH]);
    const windows = new TextDecoder('utf-16le').decode(context.read(folder, length * 2));
    // A 64-bit machine's Framework is both widths, and its layer carries both.
    const shim = `${windows}\\Microsoft.NET\\Framework${wide ? '64' : ''}\\${FRAMEWORK_V4}`
        + `\\${SHIM_IMPLEMENTATION}`;
    if (await kernel32('GetFileAttributesW', [context.wide(shim)]) === INVALID_FILE_ATTRIBUTES)
    {
        context.need?.(FRAMEWORK_LAYERS[wide ? 64 : 32]);
    }
    return NETFX_SUCCESS;
}
