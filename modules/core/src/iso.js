/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Disc images: the ISO 9660 reader the engine mounts a disc with, published
 * as `@bottlify/core/iso` for whoever has to look inside one before a machine
 * exists -- an installer finding the program a disc starts with. The two read
 * the same way, so a file found on the page is the file the guest will open.
 */

export { SECTOR_SIZE, isIsoImage, openIso }
    from './layers/filesystem/internal/iso/iso9660.js';
export { buildIso } from './layers/filesystem/internal/iso/build.js';

/**
 * A range reader over whatever holds an image: a `Blob` (a file the person
 * chose, read a range at a time and never whole), bytes already in memory, a
 * synchronous `{ size, read }` of a host's own (a file descriptor), or a
 * reader already.
 *
 * @param {Blob | Uint8Array | { size: number, read: ReadRange } | ReadRange} image
 * @returns {ReadRange}
 */
export function rangeReader(image){
    if (typeof image === 'function')
    {
        return image;
    }
    if (image instanceof Uint8Array)
    {
        return (offset, length)=>image.subarray(offset, offset + length);
    }
    if (!(image instanceof Blob))
    {
        return (offset, length)=>image.read(offset, length);
    }
    return async(offset, length)=>
        new Uint8Array(await image.slice(offset, offset + length).arrayBuffer());
}

/** @typedef {import('./layers/filesystem/internal/iso/iso9660.js').ReadRange} ReadRange */
/** @typedef {import('./layers/filesystem/internal/iso/iso9660.js').IsoImage} IsoImage */
/** @typedef {import('./layers/filesystem/internal/iso/iso9660.js').IsoEntry} IsoEntry */
