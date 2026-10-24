/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Lists or unpacks a zip archive of any size, one entry at a time from disk to
 * disk -- an installed game shipped as a zip is tens of gigabytes, more than
 * the installer's in-memory reader (`modules/installer/src/archive.js`) can
 * hold. The format as PKWARE's APPNOTE has it: the central directory names
 * every entry; stored and deflated entries; ZIP64 sizes and offsets.
 *
 * Usage:
 *   node tools/zip-extract.mjs list <archive.zip> [--depth=N]
 *       the folders down to depth N (2 by default) with their files and bytes
 *   node tools/zip-extract.mjs extract <archive.zip> <out-directory> [--prefix=<folder>]
 *       every entry, or those under <folder> with the folder taken off
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;

/**
 * @typedef {{ path: string, directory: boolean, method: number, packed: number, size: number,
 *     local: number, encrypted: boolean }} Entry
 */

/** @param {import('node:fs/promises').FileHandle} file @param {number} at @param {number} length */
async function read(file, at, length){
    const bytes = Buffer.alloc(length);
    await file.read(bytes, 0, length, at);
    return bytes;
}

/** @param {import('node:fs/promises').FileHandle} file @param {number} size @returns {Promise<Entry[]>} */
async function directory(file, size){
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await read(file, size - tailLength, tailLength);
    let at = tail.length - 22;
    while (at >= 0 && tail.readUInt32LE(at) !== END_OF_DIRECTORY)
    {
        at--;
    }
    if (at < 0)
    {
        throw new Error('not a zip archive: no end of central directory');
    }
    let count = tail.readUInt16LE(at + 10);
    let offset = tail.readUInt32LE(at + 16);
    let length = tail.readUInt32LE(at + 12);
    if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR)
    {
        const end = await read(file, Number(tail.readBigUInt64LE(at - 12)), 56);
        if (end.readUInt32LE(0) !== ZIP64_END)
        {
            throw new Error('the ZIP64 end record is not where its locator says');
        }
        count = Number(end.readBigUInt64LE(32));
        length = Number(end.readBigUInt64LE(40));
        offset = Number(end.readBigUInt64LE(48));
    }
    const central = await read(file, offset, length);
    /** @type {Entry[]} */
    const entries = [];
    let p = 0;
    for (let index = 0; index < count; index++)
    {
        if (central.readUInt32LE(p) !== CENTRAL_HEADER)
        {
            throw new Error(`entry ${index} of the central directory is damaged`);
        }
        const flags = central.readUInt16LE(p + 8);
        const method = central.readUInt16LE(p + 10);
        let packed = central.readUInt32LE(p + 20);
        let unpacked = central.readUInt32LE(p + 24);
        const nameLength = central.readUInt16LE(p + 28);
        const extraLength = central.readUInt16LE(p + 30);
        const commentLength = central.readUInt16LE(p + 32);
        let local = central.readUInt32LE(p + 42);
        const name = new TextDecoder((flags & 0x800) ? 'utf-8' : 'ibm866')
            .decode(central.subarray(p + 46, p + 46 + nameLength));
        for (let e = p + 46 + nameLength; e < p + 46 + nameLength + extraLength;)
        {
            const id = central.readUInt16LE(e);
            const extra = central.readUInt16LE(e + 2);
            if (id === 0x0001)
            {
                let field = e + 4;
                if (unpacked === 0xffffffff)
                {
                    unpacked = Number(central.readBigUInt64LE(field));
                    field += 8;
                }
                if (packed === 0xffffffff)
                {
                    packed = Number(central.readBigUInt64LE(field));
                    field += 8;
                }
                if (local === 0xffffffff)
                {
                    local = Number(central.readBigUInt64LE(field));
                }
            }
            e += 4 + extra;
        }
        p += 46 + nameLength + extraLength + commentLength;
        const path = name.replace(/\\/g, '/').replace(/^\/+/, '');
        entries.push({ path: path.replace(/\/+$/, ''), directory: path.endsWith('/'), method,
            packed, size: unpacked, local, encrypted: (flags & 1) !== 0 });
    }
    return entries;
}

/** @param {number} bytes */
const gib = bytes=>`${(bytes / 2 ** 30).toFixed(2)} GiB`;

const [command, archive, ...rest] = process.argv.slice(2);
const flag = (/** @type {string} */ name)=>rest.find(one=>one.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const file = await open(archive, 'r');
const { size } = await file.stat();
const entries = await directory(file, size);

if (command === 'list')
{
    const depth = Number(flag('depth') ?? 2);
    /** @type {Map<string, { files: number, bytes: number }>} */
    const folders = new Map();
    for (const entry of entries.filter(one=>!one.directory))
    {
        const key = entry.path.split('/').slice(0, depth).join('/');
        const held = folders.get(key) ?? { files: 0, bytes: 0 };
        held.files++;
        held.bytes += entry.size;
        folders.set(key, held);
    }
    for (const [key, { files, bytes }] of [...folders].sort())
    {
        console.log(`${gib(bytes).padStart(11)}  ${String(files).padStart(6)} files  ${key}`);
    }
    const total = entries.reduce((sum, one)=>sum + one.size, 0);
    console.log(`${gib(total).padStart(11)}  ${entries.length} entries, the archive ${gib(size)}`);
}
else if (command === 'extract')
{
    const out = rest.find(one=>!one.startsWith('--'));
    if (!out)
    {
        throw new Error('extract wants an out directory');
    }
    const prefix = (flag('prefix') ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const chosen = entries.filter(one=>!prefix || one.path === prefix
        || one.path.startsWith(`${prefix}/`));
    const total = chosen.reduce((sum, one)=>sum + one.size, 0);
    let done = 0;
    let shown = 0;
    for (const entry of chosen)
    {
        const relative = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
        if (relative.split('/').includes('..'))
        {
            throw new Error(`${entry.path} leaves the out directory`);
        }
        const target = join(out, relative);
        if (entry.directory)
        {
            await mkdir(target, { recursive: true });
            continue;
        }
        if (entry.encrypted || (entry.method !== 0 && entry.method !== 8))
        {
            throw new Error(`${entry.path}: ${entry.encrypted ? 'encrypted'
                : `method ${entry.method}`}`);
        }
        const header = await read(file, entry.local, 30);
        if (header.readUInt32LE(0) !== LOCAL_HEADER)
        {
            throw new Error(`${entry.path}: no local header where the directory says`);
        }
        const dataAt = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        await mkdir(dirname(target), { recursive: true });
        const source = createReadStream(archive, entry.packed > 0
            ? { start: dataAt, end: dataAt + entry.packed - 1 } : { start: 0, end: -1 });
        const sink = createWriteStream(target);
        if (entry.packed === 0)
        {
            sink.end();
        }
        else if (entry.method === 8)
        {
            await pipeline(source, createInflateRaw(), sink);
        }
        else
        {
            await pipeline(source, sink);
        }
        done += entry.size;
        if (done - shown > 2 ** 30 || done === total)
        {
            shown = done;
            console.log(`${gib(done)} of ${gib(total)}`);
        }
    }
    console.log(`${chosen.length} entries into ${out}`);
}
else
{
    console.log('list <archive.zip> [--depth=N] | extract <archive.zip> <out> [--prefix=<folder>]');
}
await file.close();
