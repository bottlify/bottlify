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
            : readNameTable({ bytes, view, fileOffset, toRva, nameTableRva, iatRva,
                width: image.bits === 64 ? 8 : 4 });

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
 * Writes resolved addresses into an already-mapped image's delay-load address
 * tables, the way `bindImports` does for the ordinary directory.
 *
 * Same contract, deliberately: the same resolver answers both directories, an
 * import nothing claims is recorded rather than refused, and `missing` is the
 * chance to put a stub where a call to it would otherwise land.
 *
 * The descriptor's module-handle slot is left alone. Its only reader is the
 * program's own helper, and the helper is only reached through an address-table
 * slot that still holds the thunk the linker put there -- which, once this has
 * run, no slot does. There is also nothing honest to write in it: what a
 * resolver hands back is an address per import, not a base per library, so any
 * value here would be invented, and a program that later passes it to
 * `FreeLibrary` or `GetProcAddress` would be handed the invention. Zero, which
 * is what the linker wrote, at least means "not loaded".
 *
 * A library of which nothing at all resolves is not here yet, and is left to
 * the program: its slots keep the linker's thunks, so the first call goes
 * through the program's own helper, which loads it as Windows would at that
 * moment -- from the path its notification hook names, the directories set
 * by then -- through LoadLibrary and GetProcAddress, or fails as the program
 * expects. It is reported as unresolved all the same.
 *
 * @param {{ bytes: Uint8Array, file: Uint8Array, image: import('./pe.js').PeImage }} mapped
 * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
 *        resolveImport
 * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
 *        [missing]  Where a call to an import nothing claims should land.
 * @returns {string[]} what nothing claimed, as "dll!name"
 */
export function bindDelayImports({ bytes, file, image }, resolveImport, missing){
    /** @type {string[]} */
    const unresolved = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // A PE32+ slot is a pointer eight bytes wide, as an ordinary import's is.
    /** @param {number} at @param {number} address */
    const setSlot = (at, address)=>(image.bits === 64
        ? view.setBigUint64(at, BigInt(address >>> 0), true)
        : view.setUint32(at, address >>> 0, true));

    for (const { dll, entries } of readDelayImports(file, image))
    {
        const addresses = entries.map(entry=>resolveImport(dll, entry.name, entry.ordinal));
        if (addresses.every(address=>address === null))
        {
            unresolved.push(...entries.map(entry=>`${dll}!${entry.name ?? `#${entry.ordinal}`}`));
            continue;
        }
        for (const [index, entry] of entries.entries())
        {
            const address = addresses[index];
            if (address === null)
            {
                unresolved.push(`${dll}!${entry.name ?? `#${entry.ordinal}`}`);
                const stub = missing?.(dll, entry.name, entry.ordinal) ?? null;
                if (stub !== null)
                {
                    setSlot(entry.iatRva, stub);
                }
                continue;
            }
            setSlot(entry.iatRva, address);
        }
    }
    return unresolved;
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
 * @param {4 | 8} options.width  A thunk's size: eight bytes in PE32+, its
 *        ordinal flag the top bit of the quadword.
 * @returns {import('./pe.js').ImportEntry[]}
 */
function readNameTable({ bytes, view, fileOffset, toRva, nameTableRva, iatRva, width }){
    /** @type {import('./pe.js').ImportEntry[]} */
    const entries = [];
    for (let index = 0; ; index++)
    {
        const at = fileOffset(nameTableRva + index * width);
        const thunk = view.getUint32(at, true);
        const high = width === 8 ? view.getUint32(at + 4, true) : thunk;
        if (thunk === 0 && high === 0)
        {
            break;
        }
        if ((high & 0x80000000) !== 0)
        {
            entries.push({ name: null, ordinal: thunk & 0xffff, iatRva: iatRva + index * width });
            continue;
        }
        // IMAGE_IMPORT_BY_NAME, reached the same way an ordinary import is: a
        // hint word, then a zero-terminated name.
        entries.push({
            name: readCString(bytes, fileOffset(toRva(thunk)) + 2),
            ordinal: null,
            iatRva: iatRva + index * width,
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
