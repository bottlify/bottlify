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
 * addresses against the image's preferred base -- the usual defect is reading
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

    const startRva = toRva(view.getUint32(at, true));
    const endRva = toRva(view.getUint32(at + 4, true));
    const indexRva = toRva(view.getUint32(at + 8, true));
    const callbacksRva = toRva(view.getUint32(at + 12, true));
    const zeroFillSize = view.getUint32(at + 16, true);
    const characteristics = view.getUint32(at + 20, true);

    const templateSize = endRva > startRva ? endRva - startRva : 0;

    // Built zero-filled and copied into, rather than sliced out of the file: a
    // template may reach into the tail of a section that has no bytes behind it,
    // and those bytes are zeroes in a mapped image rather than absent.
    const template = new Uint8Array(templateSize);
    if (templateSize > 0)
    {
        const from = fileOffset(startRva);
        template.set(bytes.subarray(from, Math.min(from + templateSize, bytes.length)));
    }

    /** @type {number[]} */
    const callbackRvas = [];
    if (callbacksRva !== 0)
    {
        const table = fileOffset(callbacksRva);
        for (let index = 0; index < MAX_CALLBACKS; index++)
        {
            const callback = view.getUint32(table + index * 4, true);
            if (callback === 0)
            {
                break;
            }
            callbackRvas.push(toRva(callback));
        }
    }

    return { template, templateSize, zeroFillSize, indexRva, callbackRvas, characteristics };
}
