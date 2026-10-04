/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a title's programs import that this build does not export, found by
 * reading their import tables rather than by running them.
 *
 *   node tools/import-audit.mjs <path>... [--all] [--used] [--dynamic]
 *
 * A path is a file, a directory (walked), a bundle (`.btl`) or a disc image
 * (`.iso`, ISO 9660). Every PE image found is read: its imports are checked
 * against the other images found (a title's own libraries answer each other)
 * and then against the system libraries this build makes, asked of the engine
 * itself. What is printed is each missing function with the images that
 * import it, each library nobody provides, and each image that looks packed.
 * `--all` prints the images that import nothing missing too; `--used` every
 * function of this build's libraries the images import, the missing ones
 * marked; `--dynamic` what the images name in their strings rather than their
 * import tables -- a library this build does not make, named for LoadLibrary,
 * and a function of one it does make, named for GetProcAddress.
 *
 * What this cannot see: an image packed so its real import table only exists
 * once its own code has run (it is named as packed), a payload still inside a
 * compressed cabinet or a setup's overlay (run the setup once with
 * install-watch `--copy` and audit what it unpacked), and a name a program
 * builds at run time rather than keeps as a string.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { openBundle } from './btl.mjs';
import { buildExe } from './make-pe.mjs';
import { createApp } from '../modules/core/src/app.js';
import { parsePe, readExports, readImports } from '../modules/core/src/layers/loader/internal/pe.js';

const argv = process.argv.slice(2);
const paths = argv.filter(arg=>!arg.startsWith('--'));
if (paths.length === 0)
{
    console.log('usage: node tools/import-audit.mjs'
        + ' <file|directory|bundle.btl|disc.iso>... [--all] [--used] [--dynamic]');
    process.exit(2);
}

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
async function gather(path){
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
                if (file.size < 0x40)
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
    const bytes = new Uint8Array(await readFile(path));
    return isImage(bytes) ? [{ name: basename(path), where: path, bytes }] : [];
}

const images = (await Promise.all(paths.map(gather))).flat().map(found=>{
    try
    {
        const image = parsePe(found.bytes);
        return { ...found, imports: readImports(found.bytes, image),
            exports: readExports(found.bytes, image).exports };
    }
    catch (e){
        console.log(`unreadable ${found.where}: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}).filter(entry=>entry !== null);

// The title's own libraries, by file name, answer each other's imports.
/** @type {Map<string, { names: Set<string>, ordinals: Set<number> }>} */
const own = new Map();
for (const image of /** @type {any[]} */ (images))
{
    own.set(image.name.toLowerCase(), {
        names: new Set(image.exports.map((/** @type {any} */ entry)=>entry.name).filter(Boolean)),
        ordinals: new Set(image.exports.map((/** @type {any} */ entry)=>entry.ordinal)),
    });
}

// The system libraries are asked of the engine itself, as a program's loader
// would find them.
const app = await createApp({
    executable: buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: {},
        codeSize: 0x10,
        code: ()=>[0x6a, 0x00, 0xcc, ...new Array(13).fill(0xcc)],
    }),
});

/** @type {Map<string, Map<string, Set<string>>>} missing function -> importers, by library */
const missing = new Map();
/** @type {Map<string, Map<string, Set<string>>>} every function used -> importers, by library */
const used = new Map();
/** @param {Map<string, Map<string, Set<string>>>} into @param {string} library
 *  @param {string} name @param {string} importer */
const note = (into, library, name, importer)=>{
    const byName = into.get(library) ?? new Map();
    byName.set(name, (byName.get(name) ?? new Set()).add(importer));
    into.set(library, byName);
};
/** @type {Map<string, Set<string>>} */
const absent = new Map();
/** @type {string[]} */
const packed = [];
/** @type {string[]} */
const clean = [];
for (const image of /** @type {any[]} */ (images))
{
    let gaps = 0;
    for (const library of image.imports)
    {
        const key = String(library.dll).toLowerCase();
        const ownLibrary = own.get(key);
        for (const entry of library.entries)
        {
            const label = entry.name ?? `#${entry.ordinal}`;
            const provided = ownLibrary
                ? (entry.name ? ownLibrary.names.has(entry.name)
                    : ownLibrary.ordinals.has(entry.ordinal))
                : app.debug.exported(library.dll, entry.name ?? null, entry.ordinal ?? null);
            if (provided === null)
            {
                absent.set(library.dll, (absent.get(library.dll) ?? new Set()).add(image.where));
                gaps++;
                break;
            }
            if (!ownLibrary)
            {
                note(used, library.dll, label, image.name);
            }
            if (!provided)
            {
                note(missing, library.dll, label, image.name);
                gaps++;
            }
        }
    }
    // A packer keeps one import of each library for the loader to bind and
    // looks the rest up itself once it has unpacked.
    const names = image.imports.flatMap((/** @type {any} */ library)=>library.entries
        .map((/** @type {any} */ entry)=>entry.name));
    if (image.imports.length > 1 && image.imports.every((/** @type {any} */ library)=>
        library.entries.length <= 4) && names.includes('GetProcAddress'))
    {
        packed.push(image.where);
    }
    if (gaps === 0)
    {
        clean.push(image.where);
    }
}
/**
 * The printable runs of an image, in single bytes and in UTF-16: where a name
 * handed to LoadLibrary or GetProcAddress is kept.
 *
 * @param {Uint8Array} bytes
 */
const stringsOf = bytes=>{
    /** @type {Set<string>} */
    const found = new Set();
    for (const step of [1, 2])
    {
        let run = '';
        for (let at = 0; at + step <= bytes.length; at += step)
        {
            const code = step === 1 ? bytes[at] : bytes[at] | bytes[at + 1] << 8;
            if (code >= 0x20 && code < 0x7f)
            {
                run += String.fromCharCode(code);
                continue;
            }
            if (run.length >= 4 && run.length <= 80)
            {
                found.add(run);
            }
            run = '';
        }
    }
    return found;
};

/** @type {Map<string, Set<string>>} a library named in strings that nothing provides */
const unnamed = new Map();
/** @type {Map<string, Map<string, Set<string>>>} a function named in strings, by library */
const dynamic = new Map();
if (argv.includes('--dynamic'))
{
    for (const image of /** @type {any[]} */ (images))
    {
        const strings = stringsOf(image.bytes);
        const imported = new Set(image.imports.flatMap((/** @type {any} */ library)=>
            library.entries.map((/** @type {any} */ entry)=>
                `${String(library.dll).toLowerCase()}!${entry.name}`)));
        /** @type {Set<string>} */
        const libraries = new Set(image.imports.map((/** @type {any} */ library)=>
            String(library.dll)));
        for (const text of strings)
        {
            const named = /^[A-Za-z0-9_.-]+\.(dll|drv|ocx)$/i.exec(text);
            if (!named || own.has(text.toLowerCase()))
            {
                continue;
            }
            if (app.debug.exported(text, '\u0000') === null)
            {
                unnamed.set(text, (unnamed.get(text) ?? new Set()).add(image.name));
                continue;
            }
            libraries.add(text);
        }
        for (const text of strings)
        {
            if (!/^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(text))
            {
                continue;
            }
            for (const library of libraries)
            {
                if (!own.has(library.toLowerCase())
                    && !imported.has(`${library.toLowerCase()}!${text}`)
                    && app.debug.exported(library, text) === true)
                {
                    note(dynamic, library, text, image.name);
                }
            }
        }
    }
}
await app.dispose();

console.log(`${images.length} images read`);
for (const [library, names] of [...missing].sort(([a], [b])=>a.localeCompare(b)))
{
    console.log(`MISSING ${library} (${names.size})`);
    for (const [name, importers] of [...names].sort(([a], [b])=>a.localeCompare(b)))
    {
        console.log(`  ${name}  <- ${[...importers].join(', ')}`);
    }
}
for (const [library, importers] of absent)
{
    console.log(`NO LIBRARY ${library}  <- ${[...importers].join(', ')}`);
}
for (const where of packed)
{
    console.log(`PACKED? ${where}: its imports are looked up at run time`);
}
if (argv.includes('--used'))
{
    for (const [library, names] of [...used].sort(([a], [b])=>a.localeCompare(b)))
    {
        console.log(`USED ${library} (${names.size})`);
        for (const [name, importers] of [...names].sort(([a], [b])=>a.localeCompare(b)))
        {
            const gap = missing.get(library)?.has(name) ? ' MISSING' : '';
            console.log(`  ${name}${gap}  <- ${[...importers].join(', ')}`);
        }
    }
}
for (const [library, importers] of unnamed)
{
    console.log(`NAMED, NO LIBRARY ${library}  <- ${[...importers].join(', ')}`);
}
for (const [library, names] of [...dynamic].sort(([a], [b])=>a.localeCompare(b)))
{
    console.log(`BY NAME ${library} (${names.size})`);
    for (const [name, importers] of [...names].sort(([a], [b])=>a.localeCompare(b)))
    {
        console.log(`  ${name}  <- ${[...importers].join(', ')}`);
    }
}
if (argv.includes('--all'))
{
    for (const where of clean)
    {
        console.log(`ok ${where}`);
    }
}
