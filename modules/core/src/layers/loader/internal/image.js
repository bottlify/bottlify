/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
 *        options.resolveImport
 *   Returns the guest address to write into the IAT, or null if unavailable.
 * @param {number} [options.base]  Load address; defaults to the image's own ImageBase.
 * @returns {LoadedImage}
 */
export function buildImage(file, { resolveImport, base }){
    const mapped = mapImage(file, base);
    return { ...mapped, unresolved: bindImports(mapped, resolveImport) };
}

/**
 * Maps an image and relocates it, without binding a single import.
 *
 * Mapping and binding are separate because a set of libraries that import each
 * other cannot be done one at a time: binding A needs B's exports, and B's may
 * need A's. A real loader maps every image first, so every base is settled and
 * every export directory is readable, and only then binds. Doing both in one
 * step works exactly until two libraries refer to each other, which is the
 * ordinary case among the libraries a game ships with.
 *
 * @param {Uint8Array} file
 * @param {number} [base]
 * @returns {{ base: number, entryPoint: number, bytes: Uint8Array, file: Uint8Array,
 *             image: import('./pe.js').PeImage }}
 */
export function mapImage(file, base){
    const image = parsePe(file);
    const loadBase = base ?? image.imageBase;

    if (loadBase !== image.imageBase && !image.relocatable)
    {
        throw new Error(
            `image must load at 0x${image.imageBase.toString(16)}: it carries no relocations`,
        );
    }

    // Allocated zeroed: everything not backed by file bytes — BSS tails, gaps
    // between sections, the slack inside the header page — must read as zero,
    // exactly as a fresh mapping would.
    const bytes = new Uint8Array(image.sizeOfImage);

    bytes.set(file.subarray(0, Math.min(image.sizeOfHeaders, file.length)), 0);

    for (const section of image.sections)
    {
        if (section.rawSize === 0)
        {
            continue; // pure BSS: already zero
        }
        const source = file.subarray(section.rawOffset, section.rawOffset + section.rawSize);
        // A section's raw data can exceed its virtual size when the linker padded to
        // file alignment; only what fits in the mapping is copied.
        const span = Math.min(source.length, Math.max(section.virtualSize, section.rawSize));
        bytes.set(source.subarray(0, span), section.virtualAddress);
    }

    applyRelocations(bytes, image, loadBase - image.imageBase);

    return {
        base: loadBase,
        entryPoint: loadBase + image.entryPointRva,
        bytes,
        file,
        image,
    };
}

/**
 * Writes resolved addresses into an already-mapped image's IAT.
 *
 * An import nothing claims is recorded rather than refused: a program that
 * never calls it runs, and one that does fails where it called, which is a far
 * better place to find out than here.
 *
 * @param {{ bytes: Uint8Array, file: Uint8Array, image: import('./pe.js').PeImage }} mapped
 * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
 *        resolveImport
 * @returns {string[]} what nothing claimed, as "dll!name"
 */
export function bindImports({ bytes, file, image }, resolveImport){
    /** @type {string[]} */
    const unresolved = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (const { dll, entries } of readImports(file, image))
    {
        for (const entry of entries)
        {
            const address = resolveImport(dll, entry.name, entry.ordinal);
            if (address === null)
            {
                unresolved.push(`${dll}!${entry.name ?? `#${entry.ordinal}`}`);
                continue;
            }
            view.setUint32(entry.iatRva, address >>> 0, true);
        }
    }
    return unresolved;
}

export { parsePe, readImports, rvaToFileOffset };
