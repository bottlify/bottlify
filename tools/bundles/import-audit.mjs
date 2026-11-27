/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a title's programs import that this build does not export, found by
 * reading their import tables rather than by running them.
 *
 *   node tools/bundles/import-audit.mjs <path>... [--all] [--used] [--dynamic [--specs DIR]]
 *   node tools/bundles/import-audit.mjs --fetch-specs DIR
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
 * and a function of one it does make, named for GetProcAddress. With `--specs
 * DIR`, the export lists of the real libraries (Wine's `<dll>.spec` files,
 * knowledge of the ABI kept locally, not code), a name a real library exports
 * and this build does not is listed too: what GetProcAddress will be asked for
 * and answer NULL to, which a program that does not check calls.
 * `--fetch-specs DIR` downloads those lists into DIR once; they are Wine's
 * files and are not kept in this repository.
 *
 * What this cannot see: an image packed so its real import table only exists
 * once its own code has run (it is named as packed), a payload still inside a
 * compressed cabinet or a setup's overlay (run the setup once with
 * install-watch `--copy` and audit what it unpacked), and a name a program
 * builds at run time rather than keeps as a string.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gather } from './pe-files.mjs';
import { buildExe } from '../fixtures/make-pe.mjs';
import { createApp } from '../../modules/core/src/app.js';
import { parsePe, readExports, readImports } from '../../modules/core/src/layers/loader/internal/pe.js';

const argv = process.argv.slice(2);
/** The libraries whose export lists `--fetch-specs` downloads. */
const SPEC_LIBRARIES = ['kernel32', 'ntdll', 'user32', 'gdi32', 'advapi32', 'ole32', 'oleaut32',
    'shell32', 'shlwapi', 'comctl32', 'comdlg32', 'winmm', 'version', 'wininet', 'ws2_32',
    'wsock32', 'setupapi', 'rpcrt4', 'imm32', 'msvcrt', 'd3d9', 'd3d8', 'ddraw', 'dsound',
    'dinput', 'dinput8', 'dxgi', 'd3d10', 'd3d10_1', 'd3d11', 'opengl32', 'glu32', 'psapi',
    'powrprof', 'iphlpapi', 'crypt32', 'wintrust', 'secur32', 'netapi32', 'userenv', 'uxtheme',
    'dwmapi', 'msacm32', 'avifil32', 'msvfw32', 'quartz', 'mscoree', 'oleacc', 'hhctrl.ocx',
    'riched20', 'riched32', 'mapi32', 'oledlg', 'urlmon', 'odbc32', 'winspool.drv', 'mpr', 'msi',
    'cabinet', 'lz32', 'dbghelp', 'imagehlp', 'gdiplus', 'd3dx9_43', 'xinput1_3', 'dplayx',
    'kernelbase', 'ucrtbase', 'vcruntime140', 'xinput1_4', 'bcrypt', 'shcore'];
if (argv.includes('--fetch-specs'))
{
    const into = argv[argv.indexOf('--fetch-specs') + 1];
    await mkdir(into, { recursive: true });
    for (const library of SPEC_LIBRARIES)
    {
        const file = `${library}.spec`;
        const url = `https://raw.githubusercontent.com/wine-mirror/wine/master/dlls/${library}/${file}`;
        const answer = await fetch(url);
        if (answer.ok)
        {
            await writeFile(join(into, file), await answer.text());
        }
        console.log(answer.ok ? 'fetched' : `not fetched (${answer.status})`, library);
    }
    process.exit(0);
}
const specsAt = argv.includes('--specs') ? argv[argv.indexOf('--specs') + 1] : null;
const paths = argv.filter((arg, index)=>!arg.startsWith('--') && argv[index - 1] !== '--specs');
if (paths.length === 0)
{
    console.log('usage: node tools/bundles/import-audit.mjs'
        + ' <file|directory|bundle.btl|disc.iso>... [--all] [--used] [--dynamic [--specs DIR]]');
    process.exit(2);
}

const images = (await Promise.all(paths.map(gather))).flat().map(found=>{
    try
    {
        const image = parsePe(found.bytes, { wide: true });
        return { ...found, bits: image.bits, imports: readImports(found.bytes, image),
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
// would find them -- a 64-bit image of a 64-bit process, whose libraries leave
// out the exports that only run as i386 and have the ones only Win64 has.
const apps = await Promise.all(/** @type {(32 | 64)[]} */ ([32, 64]).map(bits=>createApp({
    executable: buildExe({
        bits,
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: {},
        codeSize: 0x10,
        code: ()=>new Array(16).fill(0xcc),
    }),
})));
/** @param {{ bits: number }} image */
const appOf = image=>apps[image.bits === 64 ? 1 : 0];

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
                : appOf(image).debug.exported(library.dll, entry.name ?? null,
                    entry.ordinal ?? null);
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

/** @param {string} name  A library as a program names it, folded, with its extension. */
const libraryKey = name=>{
    const folded = name.toLowerCase().replace(/^.*[\\/]/, '');
    return /\.[a-z0-9]+$/.test(folded) ? folded : `${folded}.dll`;
};

/**
 * The names each real library exports, read from Wine's spec files: the token
 * after the calling convention and its flags on every line that is not a
 * comment.
 *
 * @type {Map<string, Set<string>>}
 */
const realExports = new Map();
if (specsAt)
{
    for (const file of (await readdir(specsAt)).filter(name=>name.endsWith('.spec')))
    {
        /** @type {Set<string>} */
        const names = new Set();
        for (const line of (await readFile(join(specsAt, file), 'utf8')).split(/\r?\n/))
        {
            const tokens = line.replace(/#.*/, '').trim().split(/\s+/);
            const name = tokens.slice(2).find(token=>!token.startsWith('-'));
            if (tokens.length >= 3 && name)
            {
                names.add(name.replace(/\(.*$/, ''));
            }
        }
        realExports.set(libraryKey(file.slice(0, -'.spec'.length)), names);
    }
}

/** @type {Map<string, Map<string, Set<string>>>} a real export named in strings, not made */
const missingByName = new Map();
/** @type {Map<string, Set<string>>} a library named in strings that nothing provides */
const unnamed = new Map();
/** @type {Map<string, Map<string, Set<string>>>} a function named in strings, by library */
const dynamic = new Map();
if (argv.includes('--dynamic'))
{
    for (const image of /** @type {any[]} */ (images))
    {
        const strings = stringsOf(image.bytes);
        // A name the image imports from any library is in its strings because
        // of its import table, and one a title's own image exports is that
        // image's -- neither is a lookup by name.
        const named = new Set(image.imports.flatMap((/** @type {any} */ library)=>
            library.entries.map((/** @type {any} */ entry)=>entry.name)));
        for (const exports of own.values())
        {
            exports.names.forEach(name=>named.add(name));
        }
        /** @type {Set<string>} */
        const libraries = new Set(image.imports.map((/** @type {any} */ library)=>
            libraryKey(String(library.dll))));
        for (const text of strings)
        {
            const library = /^[A-Za-z0-9_.-]+\.(dll|drv|ocx)$/i.exec(text);
            if (!library || own.has(text.toLowerCase()))
            {
                continue;
            }
            if (appOf(image).debug.exported(text, '\u0000') === null)
            {
                unnamed.set(text, (unnamed.get(text) ?? new Set()).add(image.name));
                continue;
            }
            libraries.add(libraryKey(text));
        }
        for (const text of strings)
        {
            if (!/^[A-Za-z_][A-Za-z0-9_]{4,}$/.test(text))
            {
                continue;
            }
            for (const library of libraries)
            {
                if (own.has(library.toLowerCase()) || named.has(text))
                {
                    continue;
                }
                const made = appOf(image).debug.exported(library, text);
                if (made === true)
                {
                    note(dynamic, libraryKey(library), text, image.name);
                }
                else if (made === false && realExports.get(libraryKey(library))?.has(text))
                {
                    note(missingByName, libraryKey(library), text, image.name);
                }
            }
        }
    }
}
await Promise.all(apps.map(app=>app.dispose()));

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
for (const [library, names] of [...missingByName].sort(([a], [b])=>a.localeCompare(b)))
{
    console.log(`MISSING BY NAME ${library} (${names.size})`);
    for (const [name, importers] of [...names].sort(([a], [b])=>a.localeCompare(b)))
    {
        console.log(`  ${name}  <- ${[...importers].join(', ')}`);
    }
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
