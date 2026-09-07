/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Delay-loaded imports: the libraries a program says it may never need.
 *
 * The tables are shaped exactly like the ordinary import directory -- a name
 * table saying what is wanted and an address table to write answers into -- and
 * are reported in the same shape, so a caller can bind them the same way.
 *
 * What is different is one bit. `Attributes` bit 0 says whether the addresses in
 * a descriptor are RVAs or virtual addresses, and linkers of the era this
 * matters for emit virtual addresses with the bit clear. Reading a virtual
 * address as an RVA does not fail: it lands the whole table at a plausible
 * offset inside the image and binds nonsense, and the program discovers it much
 * later, in a function that resolved to whatever happened to be there. So the
 * bit is honoured rather than assumed, and every address is reported as an RVA
 * whichever way it was stored.
 *
 * Nothing here arranges for a guest to call back into a helper of ours when a
 * slot is first used, and no caller should design for that: a program that
 * delay-loads generally carries its own helper, resolves names by walking the
 * library's export directory itself, and rejects anything outside that
 * library's image bounds. Binding these tables up front, before the program
 * runs, is what this tree does and it sidesteps that entirely. What it gives up
 * is the point of delay loading -- a library that would never have been touched
 * now has to exist -- which is the right trade while the alternative is a
 * program that cannot find a function at all.
 */

import { rvaToFileOffset } from './pe.js';

export const DIR_DELAY_IMPORT = 13;

/** Attributes bit 0: the addresses in this descriptor are RVAs, not VAs. */
const DELAY_ATTR_RVA_BASED = 1;

/** Eight dwords, ending in an all-zero one. */
const DESCRIPTOR_SIZE = 32;

/**
 * @typedef {Object} DelayLoadedDll
 * @property {string} dll
 * @property {boolean} rvaBased        How this descriptor stored its addresses.
 * @property {number} moduleHandleRva  Where the loaded library's handle is cached.
 * @property {import('./pe.js').ImportEntry[]} entries
 */

/**
 * Reads the delay-load directory.
 *
 * @param {Uint8Array} bytes  The raw file (not the mapped image).
 * @param {import('./pe.js').PeImage} image
 * @returns {DelayLoadedDll[]}
 */
export function readDelayImports(bytes, image){
    const directory = image.directories[DIR_DELAY_IMPORT];
    if (!directory || directory.size === 0 || directory.address === 0)
    {
        return [];
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileOffset = (/** @type {number} */ rva)=>rvaToFileOffset(image, rva);

    /** @type {DelayLoadedDll[]} */
    const result = [];
    for (let at = fileOffset(directory.address); ; at += DESCRIPTOR_SIZE)
    {
        const attributes = view.getUint32(at, true);
        const nameField = view.getUint32(at + 4, true);
        const moduleField = view.getUint32(at + 8, true);
        const iatField = view.getUint32(at + 12, true);
        const intField = view.getUint32(at + 16, true);
        if (attributes === 0 && nameField === 0 && iatField === 0 && intField === 0)
        {
            break;
        }

        const rvaBased = (attributes & DELAY_ATTR_RVA_BASED) !== 0;
        // The one line the whole file exists for. A descriptor written before
        // this bit was defined stores addresses against the preferred base.
        const toRva = (/** @type {number} */ address)=>
            rvaBased || address === 0 ? address : address - image.imageBase >>> 0;

        const iatRva = toRva(iatField);
        const nameTableRva = toRva(intField);

        // A descriptor with no name table imports nothing by name: it is bound
        // entirely through its bound table, which nothing here reads.
        const entries = nameTableRva === 0
            ? []
            : readNameTable({ bytes, view, fileOffset, toRva, nameTableRva, iatRva });

        result.push({
            dll: readCString(bytes, fileOffset(toRva(nameField))),
            rvaBased,
            moduleHandleRva: toRva(moduleField),
            entries,
        });
    }
    return result;
}

/**
 * Walks one descriptor's name table into the shape `readImports` reports.
 *
 * @param {Object} options
 * @param {Uint8Array} options.bytes
 * @param {DataView} options.view
 * @param {(rva: number) => number} options.fileOffset
 * @param {(address: number) => number} options.toRva
 * @param {number} options.nameTableRva
 * @param {number} options.iatRva
 * @returns {import('./pe.js').ImportEntry[]}
 */
function readNameTable({ bytes, view, fileOffset, toRva, nameTableRva, iatRva }){
    /** @type {import('./pe.js').ImportEntry[]} */
    const entries = [];
    for (let index = 0; ; index++)
    {
        const thunk = view.getUint32(fileOffset(nameTableRva + index * 4), true);
        if (thunk === 0)
        {
            break;
        }
        if ((thunk & 0x80000000) !== 0)
        {
            entries.push({ name: null, ordinal: thunk & 0xffff, iatRva: iatRva + index * 4 });
            continue;
        }
        // IMAGE_IMPORT_BY_NAME, reached the same way an ordinary import is: a
        // hint word, then a zero-terminated name.
        entries.push({
            name: readCString(bytes, fileOffset(toRva(thunk)) + 2),
            ordinal: null,
            iatRva: iatRva + index * 4,
        });
    }
    return entries;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function readCString(bytes, offset){
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(offset, end));
}
