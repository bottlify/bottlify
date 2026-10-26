/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Thread-local storage, as an image declares it.
 *
 * Two separate obligations live in this one directory, and a loader that meets
 * only the first leaves a program running on half-initialised state.
 *
 * The first is the template. Every thread gets its own copy of a block that
 * starts as these bytes followed by that many zeroes, and the image finds its
 * copy through a slot number -- which the *loader* chooses and writes into the
 * dword the directory points at. Leaving that dword alone does not fail: it
 * leaves it zero, and every lookup then reads slot zero, which belongs to
 * whichever image was given it. That is a wrong answer rather than a missing
 * one, which is why it is worth saying out loud.
 *
 * The second is the callbacks. The Microsoft runtime registers initialisers
 * here and expects them called with the same three arguments as DllMain, before
 * the image's entry point. An image with callbacks that are never called gets
 * through its own startup and fails later somewhere unrelated.
 *
 * Everything is reported as an RVA. The four addresses are stored as virtual
 * addresses against the image's preferred base -- quadwords in a PE32+ image,
 * dwords in a PE32 one -- the usual defect is reading
 * them as RVAs and landing a whole structure somewhere plausible and wrong --
 * so they are converted once, here, and the caller adds the base it actually
 * mapped at, exactly as it does with every other address in this tree.
 */

import { rvaToFileOffset } from './pe.js';

export const DIR_TLS = 9;

/**
 * No real image has more than a handful. The cap is not defence against a long
 * list but against a missing terminator, which would otherwise be read as
 * callbacks until the walk ran off the end of a section.
 */
const MAX_CALLBACKS = 64;

/**
 * @typedef {Object} TlsDirectory
 * @property {Uint8Array} template    The initialised bytes, zero-padded to templateSize.
 * @property {number} templateSize    Bytes copied into each thread's block.
 * @property {number} zeroFillSize    Zeroes that follow the template in that block.
 * @property {number} indexRva        The dword the loader writes its slot number into.
 * @property {number[]} callbackRvas  Initialisers, in the order they must be called.
 * @property {number} characteristics
 */

/**
 * `length` bytes from `rva` as the mapped image holds them: what the file
 * has behind a section, and zeroes past its raw data or past its end.
 *
 * @param {Uint8Array} bytes @param {import('./pe.js').PeImage} image
 * @param {number} rva @param {number} length
 */
function mappedBytes(bytes, image, rva, length){
    const out = new Uint8Array(length);
    const section = image.sections.find(each=>rva >= each.virtualAddress
        && rva < each.virtualAddress + Math.max(each.virtualSize, each.rawSize));
    if (!section)
    {
        // The headers, mapped as the file has them.
        out.set(bytes.subarray(rva, Math.min(rva + length, image.sizeOfHeaders, bytes.length)));
        return out;
    }
    const within = rva - section.virtualAddress;
    const backed = section.rawOffset === 0 ? 0 : Math.max(0, section.rawSize - within);
    const from = section.rawOffset + within;
    out.set(bytes.subarray(from, Math.min(from + Math.min(length, backed), bytes.length)));
    return out;
}

/**
 * Reads the TLS directory, or answers null when the image declares none.
 *
 * @param {Uint8Array} bytes  The raw file (not the mapped image).
 * @param {import('./pe.js').PeImage} image
 * @returns {TlsDirectory | null}
 */
export function readTls(bytes, image){
    const directory = image.directories[DIR_TLS];
    if (!directory || directory.size === 0 || directory.address === 0)
    {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileOffset = (/** @type {number} */ rva)=>rvaToFileOffset(image, rva);
    /** A stored virtual address, as the RVA everything else here speaks in. */
    const toRva = (/** @type {number} */ va)=>va === 0 ? 0 : va - image.imageBase >>> 0;
    const at = fileOffset(directory.address);
    // IMAGE_TLS_DIRECTORY64 widens the four addresses to quadwords; the two
    // dwords after them move with them.
    const size = image.bits === 64 ? 8 : 4;
    /** @param {number} offset */
    const address = offset=>(size === 8 ? Number(view.getBigUint64(offset, true))
        : view.getUint32(offset, true));

    const startRva = toRva(address(at));
    const endRva = toRva(address(at + size));
    const indexRva = toRva(address(at + 2 * size));
    const callbacksRva = toRva(address(at + 3 * size));
    const zeroFillSize = view.getUint32(at + 4 * size, true);
    const characteristics = view.getUint32(at + 4 * size + 4, true);

    const templateSize = endRva > startRva ? endRva - startRva : 0;

    // As the mapped image has them, not as the file does past them: a
    // template may lie in the tail of a section that has no bytes behind it --
    // a .tls of no raw data whatever, its file pointer the next section's --
    // and those bytes are zeroes in a mapped image, not the next section's.
    const template = mappedBytes(bytes, image, startRva, templateSize);

    /** @type {number[]} */
    const callbackRvas = [];
    if (callbacksRva !== 0)
    {
        const table = mappedBytes(bytes, image, callbacksRva, MAX_CALLBACKS * size);
        const entries = new DataView(table.buffer);
        for (let index = 0; index < MAX_CALLBACKS; index++)
        {
            const callback = size === 8 ? Number(entries.getBigUint64(index * 8, true))
                : entries.getUint32(index * 4, true);
            if (callback === 0)
            {
                break;
            }
            callbackRvas.push(toRva(callback));
        }
    }

    return { template, templateSize, zeroFillSize, indexRva, callbackRvas, characteristics };
}
