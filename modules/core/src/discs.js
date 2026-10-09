/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Disc images, mounted as drives of their own.
 *
 * A disc is the one volume nothing has to be fetched for: the person chose the
 * image, and every byte of it is on this machine. What stands between it and
 * a guest read is only that the read is synchronous and the chosen file is a
 * `Blob`, which a page reads with promises. A worker -- where the engine runs
 * -- has `FileReaderSync`, which reads a slice of a `Blob` there and then, so
 * there an image is read a range at a time and never whole. A thread without
 * it (the page's own, a test runner) reads the image into memory once, when
 * it is mounted, and says so.
 */

import { openIso } from './layers/filesystem/internal/iso/iso9660.js';
import { chunkedReads, createIsoSource } from './layers/filesystem/internal/iso/source.js';

/**
 * A disc image as a caller holding the engine directly may give it: a range
 * reader that answers at once, over a file descriptor, say.
 *
 * @typedef {{ size: number, read: (offset: number, length: number) => Uint8Array }} DiscReader
 */

/**
 * A disc image on a server that honours byte ranges -- the one a bottle keeps
 * beside its bundle. Read a range at a time, never whole.
 * @typedef {{ url: string }} DiscUrl
 */

/**
 * @typedef {Object} DiscOption
 * @property {Blob | Uint8Array | ArrayBuffer | DiscReader | DiscUrl} image
 * @property {string} [letter]  The drive it is mounted as. Absent, D: or the first
 *                              letter after it that nothing holds.
 */

/**
 * The first letter from D on that is free, which is where Windows puts the
 * first optical drive of a machine with one hard disk.
 *
 * @param {string[]} taken
 * @returns {string}
 */
export function freeLetter(taken){
    const held = new Set(taken.map(letter=>letter.toUpperCase()));
    for (let code = 0x44; code <= 0x5a; code++)
    {
        const letter = String.fromCharCode(code);
        if (!held.has(letter))
        {
            return letter;
        }
    }
    throw new Error('no drive letter is free for a disc');
}

/**
 * A synchronous reader over whatever holds an image.
 *
 * @param {DiscOption['image']} image
 * @param {any} [scope]  Where `FileReaderSync` is looked for; the global scope.
 * @returns {Promise<{ size: number, read: (offset: number, length: number) => Uint8Array,
 *                     whole: boolean }>}
 *          `whole` says the image had to be read into memory to be read at once.
 */
export async function discReader(image, scope = globalThis){
    if (image instanceof ArrayBuffer)
    {
        return discReader(new Uint8Array(image), scope);
    }
    if (image instanceof Uint8Array)
    {
        return {
            size: image.length,
            read: (offset, length)=>image.subarray(offset, offset + length),
            whole: false,
        };
    }
    if (typeof (/** @type {any} */ (image)).read === 'function')
    {
        const reader = /** @type {DiscReader} */ (image);
        return { size: reader.size, read: (offset, length)=>reader.read(offset, length),
            whole: false };
    }
    if (typeof (/** @type {any} */ (image)).url === 'string')
    {
        return urlReader(/** @type {DiscUrl} */ (image).url, scope);
    }
    const blob = /** @type {Blob} */ (image);
    if (typeof scope.FileReaderSync === 'function')
    {
        const reader = new scope.FileReaderSync();
        return {
            size: blob.size,
            read: (offset, length)=>new Uint8Array(
                reader.readAsArrayBuffer(blob.slice(offset, offset + length))),
            whole: false,
        };
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { ...await discReader(bytes, scope), whole: true };
}

/**
 * A reader over an image on a server: each read a synchronous ranged request,
 * which a worker may make and which is what a guest's ReadFile waits on.
 *
 * @param {string} url @param {any} scope
 */
function urlReader(url, scope){
    if (typeof scope.XMLHttpRequest !== 'function' || typeof scope.document === 'object')
    {
        throw new Error(`the disc at ${url} can only be read from a worker`);
    }
    /** @param {number} first @param {number} last */
    const ranged = (first, last)=>{
        const request = new scope.XMLHttpRequest();
        request.open('GET', url, false);
        request.responseType = 'arraybuffer';
        request.setRequestHeader('Range', `bytes=${first}-${last}`);
        request.send();
        if (request.status !== 206)
        {
            throw new Error(`the disc at ${url} answered ${request.status} to a range`);
        }
        return request;
    };
    const total = /\/(\d+)$/.exec(ranged(0, 0).getResponseHeader('Content-Range') ?? '');
    if (!total)
    {
        throw new Error(`the disc at ${url} does not say how long it is`);
    }
    const size = Number(total[1]);
    return {
        size,
        read: (/** @type {number} */ offset, /** @type {number} */ length)=>(length <= 0
            ? new Uint8Array(0)
            : new Uint8Array(ranged(offset, Math.min(offset + length, size) - 1).response)),
        whole: false,
    };
}

/**
 * Mounts every disc the options name, each as a CD-ROM drive: read-only,
 * with the label and the serial number the disc itself records.
 *
 * @param {Object} options
 * @param {DiscOption[] | undefined} options.discs
 * @param {any} options.filesystem  The filesystem layer's api.
 * @param {{ emit: (name: string, payload: any) => void }} [options.events]
 * @param {any} [options.scope]
 * @returns {Promise<{ letter: string, label: string }[]>}
 */
export async function mountDiscs({ discs, filesystem, events, scope }){
    /** @type {{ letter: string, label: string }[]} */
    const mounted = [];
    for (const disc of discs ?? [])
    {
        const taken = filesystem.drives();
        const asked = disc.letter?.slice(0, 1).toUpperCase();
        if (asked && taken.includes(asked))
        {
            // Moving the disc elsewhere would leave whoever named the letter
            // starting a program from a drive that is something else.
            throw new Error(`cannot mount a disc as ${asked}: the letter is taken`);
        }
        const letter = asked ?? freeLetter(taken);
        const reader = await discReader(disc.image, scope);
        const image = await openIso(chunkedReads(reader.read, { size: reader.size }));
        filesystem.mount(letter, {
            source: createIsoSource(image),
            readOnly: true,
            volume: {
                kind: 'cdrom',
                label: image.volume.label,
                serial: image.volume.serial,
                size: image.volume.size,
                unicode: image.volume.joliet,
            },
        });
        events?.emit('disc', {
            letter,
            label: image.volume.label,
            files: image.entries.filter(entry=>!entry.directory).length,
            bytes: reader.size,
            joliet: image.volume.joliet,
            whole: reader.whole,
        });
        mounted.push({ letter, label: image.volume.label });
    }
    return mounted;
}
