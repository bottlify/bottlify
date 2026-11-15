/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which .NET Framework a program needs, and whether the machine has it.
 *
 * A managed program is an image with a COM descriptor directory (the CLR
 * header), whose metadata names the runtime it was built against. What runs
 * it is a Framework installed on the machine - here, the files of one on the
 * volume. Where none that can run it is there, the run asks its embedder for
 * the layer that carries one (`layer-needed`): the .NET Framework 4.8, built
 * once per machine width and shared by every bottle (`roadmap/dotnet-layer.md`).
 * 4.8 updates 4.0 to 4.7.2 in place and so runs every CLR 4 program; a CLR 2
 * program is satisfied by a CLR 2 runtime where one is installed.
 */

import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { FRAMEWORK_V4, SHIM_IMPLEMENTATION } from './functions.js';

/** IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR. */
const DIR_COM_DESCRIPTOR = 14;
/** The metadata root's signature, "BSJB". */
const METADATA_SIGNATURE = 0x424a5342;

/** The layers that carry the .NET Framework 4.8, by the width of the program. */
export const FRAMEWORK_LAYERS = Object.freeze({ 32: 'dotnet48-x86', 64: 'dotnet48-amd64' });

/** The runtime CLR 2 programs (the Framework 2.0 to 3.5) are run by, and its engine's file. */
const FRAMEWORK_V2 = 'v2.0.50727';
const CLR2_RUNTIME = 'mscorwks.dll';

/**
 * A managed image's width and the runtime its metadata was built against
 * (`v4.0.30319`, `v2.0.50727`), or null for an image that is not managed or
 * not an image at all.
 *
 * @param {Uint8Array} executable
 * @returns {{ bits: 32 | 64, runtime: string | null } | null}
 */
export function managedImageOf(executable){
    let image;
    try
    {
        image = parsePe(executable, { wide: true });
    }
    catch {
        return null;
    }
    const descriptor = image.directories[DIR_COM_DESCRIPTOR];
    if (!descriptor || descriptor.size === 0)
    {
        return null;
    }
    const view = new DataView(executable.buffer, executable.byteOffset, executable.byteLength);
    /** @param {number} rva @param {number} length */
    const at = (rva, length)=>{
        const offset = rvaToFileOffset(image, rva);
        return offset >= 0 && offset + length <= executable.length ? offset : -1;
    };
    // IMAGE_COR20_HEADER: cb, the runtime's version, then MetaData's RVA and size.
    const header = at(descriptor.address, 16);
    const root = header < 0 ? -1 : at(view.getUint32(header + 8, true), 16);
    if (root < 0 || view.getUint32(root, true) !== METADATA_SIGNATURE)
    {
        return { bits: image.bits, runtime: null };
    }
    const length = view.getUint32(root + 12, true);
    const bytes = executable.subarray(root + 16, Math.min(root + 16 + length, executable.length));
    const end = bytes.indexOf(0);
    return { bits: image.bits,
        runtime: String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end)) };
}

/**
 * The layer a program needs mounted, or null: none for an image that is not
 * managed, or whose runtime the volume has - a Framework 4's shim
 * implementation for a CLR 4 program, that or a CLR 2 runtime for a CLR 2 one.
 *
 * @param {Uint8Array} executable
 * @param {(path: string) => boolean} exists  Whether the volume has that file.
 * @param {string} windowsDirectory
 * @returns {string | null}
 */
export function frameworkNeeded(executable, exists, windowsDirectory){
    const managed = managedImageOf(executable);
    if (managed === null)
    {
        return null;
    }
    const width = managed.bits === 64 ? '64' : '';
    const framework = `${windowsDirectory}\\Microsoft.NET\\Framework${width}`;
    const clr4 = exists(`${framework}\\${FRAMEWORK_V4}\\${SHIM_IMPLEMENTATION}`);
    const clr2 = /^v[12]\./.test(managed.runtime ?? '')
        && exists(`${framework}\\${FRAMEWORK_V2}\\${CLR2_RUNTIME}`);
    return clr4 || clr2 ? null : FRAMEWORK_LAYERS[managed.bits];
}
