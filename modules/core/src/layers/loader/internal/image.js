/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { applyRelocations, parsePe, readImports, rvaToFileOffset } from './pe.js';

/**
 * Turning a parsed PE into a laid-out image.
 *
 * The image is built in a host-side buffer first and written to the guest in one
 * go. That keeps the ordering rules — zero, map, relocate, bind — enforced by
 * the structure of this function rather than by a comment, and it means a caller
 * can inspect the finished image without an emulator running.
 */

/**
 * @typedef {Object} LoadedImage
 * @property {number} base          Address the image is loaded at.
 * @property {number} entryPoint    Absolute address of the entry point.
 * @property {Uint8Array} bytes     The mapped image, indexed by RVA.
 * @property {string[]} unresolved  Imports nothing claimed, as "dll!name".
 */

/**
 * @param {Uint8Array} file  Raw executable bytes.
 * @param {Object} options
 * @param {(dll: string, name: string | null, ordinal: number | null) => number | null} options.resolveImport
 *   Returns the guest address to write into the IAT, or null if unavailable.
 * @param {number} [options.base]  Load address; defaults to the image's own ImageBase.
 * @returns {LoadedImage}
 */
export function buildImage(file, { resolveImport, base }){
    const image = parsePe(file);
    const loadBase = base ?? image.imageBase;

    if (loadBase !== image.imageBase && !image.relocatable){
        throw new Error(
            `image must load at 0x${image.imageBase.toString(16)}: it carries no relocations`,
        );
    }

    // Allocated zeroed: everything not backed by file bytes — BSS tails, gaps
    // between sections, the slack inside the header page — must read as zero,
    // exactly as a fresh mapping would.
    const bytes = new Uint8Array(image.sizeOfImage);

    bytes.set(file.subarray(0, Math.min(image.sizeOfHeaders, file.length)), 0);

    for (const section of image.sections){
        if (section.rawSize === 0) continue; // pure BSS: already zero
        const source = file.subarray(section.rawOffset, section.rawOffset + section.rawSize);
        // A section's raw data can exceed its virtual size when the linker padded to
        // file alignment; only what fits in the mapping is copied.
        const span = Math.min(source.length, Math.max(section.virtualSize, section.rawSize));
        bytes.set(source.subarray(0, span), section.virtualAddress);
    }

    applyRelocations(bytes, image, loadBase - image.imageBase);

    /** @type {string[]} */
    const unresolved = [];
    const view = new DataView(bytes.buffer);

    for (const { dll, entries } of readImports(file, image)){
        for (const entry of entries){
            const address = resolveImport(dll, entry.name, entry.ordinal);
            if (address === null){
                unresolved.push(`${dll}!${entry.name ?? `#${entry.ordinal}`}`);
                continue;
            }
            view.setUint32(entry.iatRva, address >>> 0, true);
        }
    }

    return {
        base: loadBase,
        entryPoint: loadBase + image.entryPointRva,
        bytes,
        unresolved,
    };
}

export { parsePe, readImports, rvaToFileOffset };
