/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The PE images a title holds, wherever they sit: a file, a directory (walked),
 * a bundle (`.btl`) or a disc image (`.iso`, ISO 9660). Shared by the audits
 * that read a title's programs without running them.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { openBundle } from '../lib/btl.mjs';

/** @typedef {{ name: string, where: string, bytes: Uint8Array }} Found */

/** @param {Uint8Array} bytes */
const isImage = bytes=>{
    if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    {
        return false;
    }
    const at = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0x3c, true);
    return at + 4 <= bytes.length && bytes[at] === 0x50 && bytes[at + 1] === 0x45
        && bytes[at + 2] === 0 && bytes[at + 3] === 0;
};

/**
 * The files of an ISO 9660 image, by its primary volume descriptor's tree.
 *
 * @param {string} path
 * @returns {Promise<Found[]>}
 */
async function readDisc(path){
    const SECTOR = 2048;
    const handle = await open(path, 'r');
    /** @param {number} offset @param {number} length */
    const read = async(offset, length)=>{
        const buffer = new Uint8Array(length);
        await handle.read(buffer, 0, length, offset);
        return buffer;
    };
    /** @type {Found[]} */
    const found = [];
    try
    {
        const descriptor = await read(16 * SECTOR, SECTOR);
        if (descriptor[0] !== 1 || String.fromCharCode(...descriptor.subarray(1, 6)) !== 'CD001')
        {
            throw new Error(`${path}: no ISO 9660 primary volume descriptor`);
        }
        /** @param {Uint8Array} record @param {string} prefix */
        const walk = async(record, prefix)=>{
            const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
            const directory = await read(view.getUint32(2, true) * SECTOR,
                view.getUint32(10, true));
            for (let at = 0; at < directory.length;)
            {
                const length = directory[at];
                if (length === 0)
                {
                    at = (Math.floor(at / SECTOR) + 1) * SECTOR;
                    continue;
                }
                const entry = directory.subarray(at, at + length);
                at += length;
                const nameLength = entry[32];
                const raw = entry.subarray(33, 33 + nameLength);
                if (nameLength === 1 && raw[0] <= 1)
                {
                    continue;
                }
                const name = String.fromCharCode(...raw).replace(/;\d+$/, '').replace(/\.$/, '');
                const fields = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
                if ((entry[25] & 2) !== 0)
                {
                    await walk(entry, `${prefix}${name}\\`);
                    continue;
                }
                const start = fields.getUint32(2, true) * SECTOR;
                const size = fields.getUint32(10, true);
                if (size >= 0x40 && isImage(await read(start, Math.min(size, 0x1000))))
                {
                    found.push({ name, where: `${path}:${prefix}${name}`,
                        bytes: await read(start, size) });
                }
            }
        };
        await walk(descriptor.subarray(156, 190), '');
    }
    finally
    {
        await handle.close();
    }
    return found;
}

/**
 * Every PE image under a path.
 *
 * @param {string} path
 * @returns {Promise<Found[]>}
 */
export async function gather(path){
    const info = await stat(path);
    if (info.isDirectory())
    {
        const all = await Promise.all((await readdir(path)).map(name=>gather(join(path, name))));
        return all.flat();
    }
    const kind = extname(path).toLowerCase();
    if (kind === '.iso')
    {
        return readDisc(path);
    }
    if (kind === '.btl')
    {
        const bundle = await openBundle(path);
        /** @type {Found[]} */
        const found = [];
        try
        {
            for (const file of bundle.list())
            {
                // Only an image is read whole: a game's archives run to gigabytes.
                if (file.size < 0x40 || !isMz(new Uint8Array(await bundle.read(file.path, 0, 2))))
                {
                    continue;
                }
                const bytes = new Uint8Array(await bundle.read(file.path));
                if (isImage(bytes))
                {
                    found.push({ name: basename(file.path.replaceAll('\\', '/')),
                        where: `${path}:${file.path}`, bytes });
                }
            }
        }
        finally
        {
            await bundle.close();
        }
        return found;
    }
    const head = await open(path, 'r');
    const mz = Buffer.alloc(2);
    await head.read(mz, 0, 2, 0).finally(()=>head.close());
    if (info.size < 0x40 || !isMz(mz))
    {
        return [];
    }
    const bytes = new Uint8Array(await readFile(path));
    return isImage(bytes) ? [{ name: basename(path), where: path, bytes }] : [];
}

/** Whether bytes start as an MS-DOS header does, as every PE image does. @param {Uint8Array} bytes */
const isMz = bytes=>bytes[0] === 0x4d && bytes[1] === 0x5a;
