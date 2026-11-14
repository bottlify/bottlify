/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a bottle standing on a layer (`bundle.layers`): the same files
 * and the same registry reached two ways - carried in the bottle's own bundle,
 * or delivered by a layer under it - and a program that cannot tell which.
 *
 * The program is a real one: CreateFile and ReadFile, GetFileSize,
 * GetFileAttributes, FindFirstFile and FindNextFile, RegOpenKeyEx and
 * RegQueryValueEx, every answer and out-structure written into one buffer it
 * saves as a file. Both arms' buffers must be the same, and the same as what
 * was planted - with the bottle's file over the layer's of one path, the
 * bottle's key over the layer's and the session's over both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BOTTLE_DRIVE_PATH, BOTTLE_REGISTRY_PATH, BOTTLE_SYSTEM_PATH, createApp } from './app.js';
import { writeBundle } from './bundle-node.js';
import { createHive, HKEY_LOCAL_MACHINE, REG_DWORD, REG_SZ } from './layers/win32/advapi32/registry.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** Small blocks, so the layer's larger file spans several and a read of it misses. */
const BLOCK_SIZE = 64 * 1024;

/** @param {string} text @returns {number[]} */
const cstr = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);
/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    (value >>> 24) & 0xff];
/** @param {string} text */
const sz = text=>new TextEncoder().encode(`${text}\0`);

const FRAMEWORK = 'Microsoft.NET\\Framework\\v4.0.30319';
const NDP = 'SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full';
const GAME = 'SOFTWARE\\Vendor\\Game\\1.0';

const CLR = randomBytes(150 * 1024);
const PROBE = randomBytes(9000);
const LAYER_CONFIG = 'the layer\'s machine.config';
const BOTTLE_CONFIG = 'the bottle\'s machine.config, over it';
const APP_CONFIG = 'the bottle\'s own';

/**
 * What the program reads, in the order it reads it: files (whole, into room
 * of `room` bytes), attributes, two directory listings and registry values.
 */
const FILES = [
    { path: `C:\\Windows\\${FRAMEWORK}\\clr.dll`, room: 160 * 1024 },
    { path: `C:\\WINDOWS\\${FRAMEWORK.toUpperCase()}\\MACHINE.CONFIG`, room: 256 },
    { path: `c:\\windows\\${FRAMEWORK}\\app.config`, room: 256 },
    { path: 'C:\\WINDOWS\\system32\\layerprobe.dll', room: 16 * 1024 },
];
const ATTRIBUTES = [`C:\\Windows\\${FRAMEWORK}\\clr.dll`, 'C:\\Windows\\Microsoft.NET',
    'C:\\WINDOWS\\system32\\layerprobe.dll', 'C:\\stray.txt', 'C:\\App\\stray.txt'];
const LISTINGS = [{ pattern: `C:\\Windows\\${FRAMEWORK}\\*`, records: 8 },
    { pattern: 'C:\\WINDOWS\\system32\\layer*.dll', records: 3 }];
const VALUES = [[NDP, 'Release'], [NDP, 'Version'], [NDP, 'InstallPath'], [NDP, 'Missing'],
    [GAME, 'Path']];

/** WIN32_FIND_DATAA, and the answer of the call that filled it before it. */
const FIND_RECORD = 4 + 320;
/** A value's room: RegOpenKeyEx's answer, RegQueryValueEx's, the type, the size, the data. */
const VALUE_ROOM = 16 + 256;

/** Where each observation lands in the program's buffer. */
function layout(){
    let at = 0;
    /** @param {number} bytes */
    const take = bytes=>{
        const from = at;
        at += bytes;
        return from;
    };
    // A file: bytes read, ReadFile's answer, GetFileSize's, then the bytes.
    const files = FILES.map(file=>({ ...file, at: take(12 + file.room) }));
    const attributes = ATTRIBUTES.map(path=>({ path, at: take(4) }));
    const listings = LISTINGS.map(listing=>({ ...listing,
        at: take(listing.records * FIND_RECORD) }));
    const values = VALUES.map(([key, name])=>({ key, name, at: take(VALUE_ROOM) }));
    return { files, attributes, listings, values, size: at };
}
const LAYOUT = layout();

/**
 * The program: every observation into a buffer it allocates (`out`, larger
 * than an image's data is made), then the buffer saved as C:\observed.bin.
 */
function probeProgram(){
    const GENERIC_READ = 0x80000000;
    const GENERIC_WRITE = 0x40000000;
    const KEY_READ = 0x20019;
    /** @type {Record<string, number[]>} */
    const data = {
        out: [0, 0, 0, 0],
        handle: [0, 0, 0, 0], key: [0, 0, 0, 0], counted: [0, 0, 0, 0],
        saved: cstr('C:\\observed.bin'),
    };
    LAYOUT.files.forEach((file, at)=>{
        data[`file${at}`] = cstr(file.path);
    });
    LAYOUT.attributes.forEach((one, at)=>{
        data[`attr${at}`] = cstr(one.path);
    });
    LAYOUT.listings.forEach((one, at)=>{
        data[`list${at}`] = cstr(one.pattern);
    });
    LAYOUT.values.forEach((one, at)=>{
        data[`key${at}`] = cstr(one.key);
        data[`value${at}`] = cstr(one.name);
    });
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateFileA', 'ReadFile', 'GetFileSize', 'CloseHandle', 'WriteFile',
                'GetFileAttributesA', 'FindFirstFileA', 'FindNextFileA', 'FindClose', 'ExitProcess',
                'VirtualAlloc'],
            'ADVAPI32.dll': ['RegOpenKeyExA', 'RegQueryValueExA', 'RegCloseKey'],
        },
        codeSize: 0x1000,
        data,
        code: ({ iat, at })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** @param {number} offset  push out + offset: mov eax, [out]; add eax, offset; push eax */
            const pushOut = offset=>[0xa1, ...u32(at('out')), 0x05, ...u32(offset), 0x50];
            /** @param {number} address */
            const pushAt = address=>[0xff, 0x35, ...u32(address)];
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {number} address  mov [address], eax */
            const keep = address=>[0xa3, ...u32(address)];
            /** @param {number} offset  mov ecx, [out]; mov [ecx + offset], eax */
            const keepOut = offset=>[0x8b, 0x0d, ...u32(at('out')), 0x89, 0x81, ...u32(offset)];
            // out = VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
            const code = [...push(4), ...push(0x3000), ...push(LAYOUT.size), ...push(0),
                ...call('VirtualAlloc'), ...keep(at('out'))];
            LAYOUT.files.forEach((file, index)=>{
                code.push(
                    // CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                    //     OPEN_EXISTING, 0, NULL)
                    ...push(0), ...push(0), ...push(3), ...push(0), ...push(1),
                    ...push(GENERIC_READ), ...push(at(`file${index}`)), ...call('CreateFileA'),
                    ...keep(at('handle')),
                    // ReadFile(handle, out + 12, room, &out[0], NULL)
                    ...push(0), ...pushOut(file.at), ...push(file.room),
                    ...pushOut(file.at + 12), ...pushAt(at('handle')), ...call('ReadFile'),
                    ...keepOut(file.at + 4),
                    ...push(0), ...pushAt(at('handle')), ...call('GetFileSize'),
                    ...keepOut(file.at + 8),
                    ...pushAt(at('handle')), ...call('CloseHandle'));
            });
            LAYOUT.attributes.forEach((one, index)=>{
                code.push(...push(at(`attr${index}`)), ...call('GetFileAttributesA'),
                    ...keepOut(one.at));
            });
            LAYOUT.listings.forEach((one, index)=>{
                // The first record's answer is the search's handle: not kept,
                // as a handle's value is not the volume's answer.
                code.push(...pushOut(one.at + 4), ...push(at(`list${index}`)),
                    ...call('FindFirstFileA'), ...keep(at('handle')));
                for (let record = 1; record < one.records; record++)
                {
                    const from = one.at + record * FIND_RECORD;
                    code.push(...pushOut(from + 4), ...pushAt(at('handle')),
                        ...call('FindNextFileA'), ...keepOut(from));
                }
                code.push(...pushAt(at('handle')), ...call('FindClose'));
            });
            LAYOUT.values.forEach((one, index)=>{
                const from = one.at;
                code.push(
                    // RegOpenKeyExA(HKLM, key, 0, KEY_READ, &key)
                    ...push(at('key')), ...push(KEY_READ), ...push(0), ...push(at(`key${index}`)),
                    ...push(HKEY_LOCAL_MACHINE), ...call('RegOpenKeyExA'), ...keepOut(from),
                    // The room: mov ecx, [out]; mov dword [ecx + from + 12], 256
                    0x8b, 0x0d, ...u32(at('out')), 0xc7, 0x81, ...u32(from + 12),
                    ...u32(VALUE_ROOM - 16),
                    // RegQueryValueExA(key, name, NULL, &type, data, &size)
                    ...pushOut(from + 12), ...pushOut(from + 16), ...pushOut(from + 8), ...push(0),
                    ...push(at(`value${index}`)), ...pushAt(at('key')), ...call('RegQueryValueExA'),
                    ...keepOut(from + 4),
                    ...pushAt(at('key')), ...call('RegCloseKey'));
            });
            code.push(
                // CreateFileA(saved, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL)
                ...push(0), ...push(0), ...push(2), ...push(0), ...push(0),
                ...push(GENERIC_WRITE), ...push(at('saved')), ...call('CreateFileA'),
                ...keep(at('handle')),
                ...push(0), ...push(at('counted')), ...push(LAYOUT.size), ...pushOut(0),
                ...pushAt(at('handle')), ...call('WriteFile'),
                ...pushAt(at('handle')), ...call('CloseHandle'),
                ...push(0), ...call('ExitProcess'));
            return code;
        },
    });
}

/**
 * A hive of these values under HKLM.
 *
 * @param {[string, string, number, Uint8Array][]} values  key, name, type, data
 */
function hiveOf(values){
    const hive = createHive();
    for (const [path, name, type, bytes] of values)
    {
        hive.setValue(hive.create(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), path).key,
            name, type, bytes);
    }
    return hive.toJSON();
}

const RELEASE = Uint8Array.from(u32(528040));
const LAYER_HIVE = hiveOf([[NDP, 'Release', REG_DWORD, RELEASE],
    [NDP, 'Version', REG_SZ, sz('4.8.03761')],
    [NDP, 'InstallPath', REG_SZ, sz(`C:\\Windows\\${FRAMEWORK}\\`)]]);
const BOTTLE_HIVE = hiveOf([[NDP, 'InstallPath', REG_SZ, sz('C:\\the bottle says')],
    [GAME, 'Path', REG_SZ, sz('C:\\Games\\Game')]]);
/** The bottle's own hive with the layer's keys in it: one installation of both. */
const WHOLE_HIVE = hiveOf([[NDP, 'Release', REG_DWORD, RELEASE],
    [NDP, 'Version', REG_SZ, sz('4.8.03761')],
    [NDP, 'InstallPath', REG_SZ, sz('C:\\the bottle says')],
    [GAME, 'Path', REG_SZ, sz('C:\\Games\\Game')]]);
const SESSION_HIVE = hiveOf([[NDP, 'Version', REG_SZ, sz('the session\'s')]]);

/** The layer's files, by their path in a bundle. */
const LAYER_FILES = {
    [`${BOTTLE_DRIVE_PATH}\\WINDOWS\\${FRAMEWORK}\\clr.dll`]: CLR,
    [`${BOTTLE_DRIVE_PATH}\\WINDOWS\\${FRAMEWORK}\\machine.config`]: LAYER_CONFIG,
    [`${BOTTLE_SYSTEM_PATH}\\layerprobe.dll`]: PROBE,
};
/** The bottle's own, spelt as its setup spelt them. */
const BOTTLE_FILES = {
    [`${BOTTLE_DRIVE_PATH}\\Windows\\${FRAMEWORK}\\machine.config`]: BOTTLE_CONFIG,
    [`${BOTTLE_DRIVE_PATH}\\Windows\\${FRAMEWORK}\\app.config`]: APP_CONFIG,
    'game.dat': randomBytes(4096),
};

/**
 * A bundle of these files, fetched by range off the disk, with what was asked of it counted.
 *
 * @param {Record<string, string | Uint8Array | undefined>} files  undefined: left out
 * @param {any} hive  its `.bottlify\registry.json`
 */
async function pack(files, hive){
    const root = await mkdtemp(join(tmpdir(), 'btl-layer-'));
    const out = await mkdtemp(join(tmpdir(), 'btl-layer-out-'));
    for (const [path, bytes] of Object.entries({ ...files,
        [BOTTLE_REGISTRY_PATH]: JSON.stringify(hive) }))
    {
        if (bytes === undefined)
        {
            continue;
        }
        const file = join(root, ...path.split('\\'));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes);
    }
    const path = join(out, 'bundle.btl');
    await writeBundle({ root, output: path, blockSize: BLOCK_SIZE });
    const handle = await open(path, 'r');
    const fetched = { calls: 0, bytes: 0 };
    return {
        fetched,
        /** @param {number} offset @param {number} length */
        fetch: async(offset, length)=>{
            fetched.calls++;
            fetched.bytes += length;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            return new Uint8Array(buffer);
        },
        cleanup: async()=>{
            await handle.close();
            await rm(root, { recursive: true, force: true });
            await rm(out, { recursive: true, force: true });
        },
    };
}

/**
 * Runs the program over a volume and answers what it saved, and what was said.
 *
 * @param {any} bundle  `createApp`'s option
 */
async function observe(bundle){
    const app = await createApp({
        executable: probeProgram(),
        bundle,
        storage: { load: async()=>({ files: [], registry: SESSION_HIVE }) },
    });
    /** @type {any[]} */
    const unmounted = [];
    app.on('layer-files-unmounted', (/** @type {any} */ payload)=>unmounted.push(payload));
    try
    {
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0);
        return { observed: app.files.read('C:\\observed.bin'), unmounted };
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {Uint8Array} bytes @param {number} at */
const word = (bytes, at)=>new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
/** @param {Uint8Array} bytes */
const latin = bytes=>String.fromCharCode(...bytes);

/**
 * A listing's records the program was given, by name: the order is the
 * volume's (each layer's entries in the order it lists them, as a session's
 * come after the bundle's), which neither arm is asked to share.
 *
 * @param {Uint8Array} observed @param {{ at: number, records: number }} listing
 */
const recordsOf = (observed, listing)=>Array.from({ length: listing.records }, (_, record)=>
    observed.subarray(listing.at + record * FIND_RECORD + 4,
        listing.at + (record + 1) * FIND_RECORD))
    .filter(record=>record[44] !== 0)
    .map(record=>({ name: latin(record.subarray(44, record.indexOf(0, 44))), record: [...record] }))
    .sort((left, right)=>(left.name < right.name ? -1 : 1));

test('a layer\'s files and keys are what a program finds, as if the bottle carried them',
    { timeout: 120_000 }, async t=>{
        const whole = await pack({ ...LAYER_FILES, ...BOTTLE_FILES,
            [`${BOTTLE_DRIVE_PATH}\\WINDOWS\\${FRAMEWORK}\\machine.config`]: undefined },
        WHOLE_HIVE);
        const bottle = await pack(BOTTLE_FILES, BOTTLE_HIVE);
        const layer = await pack({ ...LAYER_FILES, 'stray.txt': 'not a system file' }, LAYER_HIVE);
        t.after(()=>Promise.all([whole, bottle, layer].map(one=>one.cleanup())));

        const carried = await observe({ fetch: whole.fetch, store: null, id: 'whole' });
        const layered = await observe({ fetch: bottle.fetch, store: null, id: 'bottle',
            layers: [{ id: 'netfx48', fetch: layer.fetch, store: null }] });
        const [a, b] = [carried.observed, layered.observed];
        assert.equal(a.length, LAYOUT.size);

        // What was planted, read back: the gate compares two runs that read
        // something, not two that failed alike.
        const [clr, config, app, probe] = LAYOUT.files;
        assert.equal(word(a, clr.at), CLR.length, 'the whole of the layer\'s file was read');
        assert.deepEqual([...a.subarray(clr.at + 12, clr.at + 12 + CLR.length)], [...CLR]);
        assert.equal(latin(a.subarray(config.at + 12, config.at + 12 + word(a, config.at))),
            BOTTLE_CONFIG, 'the bottle\'s file over the layer\'s');
        assert.equal(latin(a.subarray(app.at + 12, app.at + 12 + word(a, app.at))), APP_CONFIG);
        assert.equal(word(a, probe.at + 8), PROBE.length);
        const [, folder, , stray, strayInApp] = LAYOUT.attributes;
        assert.equal(word(a, folder.at) & 0x10, 0x10, 'a directory');
        assert.equal(word(a, stray.at), 0xffffffff);
        assert.equal(word(a, strayInApp.at), 0xffffffff);
        const [release, version, installPath, missing, game] = LAYOUT.values;
        assert.deepEqual([word(a, release.at), word(a, release.at + 4), word(a, release.at + 8),
            word(a, release.at + 16)], [0, 0, REG_DWORD, 528040]);
        /** @param {Uint8Array} bytes @param {number} at */
        const text = (bytes, at)=>latin(bytes.subarray(at + 16,
            at + 16 + word(bytes, at + 12) - 1));
        assert.equal(text(a, version.at), 'the session\'s', 'the session\'s value over both');
        assert.equal(text(a, installPath.at), 'C:\\the bottle says',
            'the bottle\'s over the layer\'s');
        assert.equal(word(a, missing.at + 4), 2, 'ERROR_FILE_NOT_FOUND');
        assert.equal(text(a, game.at), 'C:\\Games\\Game');
        assert.deepEqual(recordsOf(a, LAYOUT.listings[0]).map(one=>one.name),
            ['.', '..', 'app.config', 'clr.dll', 'machine.config']);
        assert.deepEqual(recordsOf(a, LAYOUT.listings[1]).map(one=>one.name), ['layerprobe.dll']);

        // The gate: every answer, out-structure and byte the same either way.
        for (const listing of LAYOUT.listings)
        {
            assert.deepEqual(recordsOf(b, listing), recordsOf(a, listing), listing.pattern);
        }
        /** @param {Uint8Array} bytes */
        const unlisted = bytes=>{
            const copy = bytes.slice();
            for (const listing of LAYOUT.listings)
            {
                copy.fill(0, listing.at, listing.at + listing.records * FIND_RECORD);
            }
            return copy;
        };
        assert.deepEqual(unlisted(b), unlisted(a));

        assert.deepEqual(carried.unmounted, []);
        assert.deepEqual(layered.unmounted, [{ files: 1, layer: 'netfx48' }],
            'the file outside the layer\'s system files is said not to be there');
    });

test('a layer is cached once, by its own name, whatever bottle stands on it',
    { timeout: 120_000 }, async t=>{
        const bottle = await pack(BOTTLE_FILES, BOTTLE_HIVE);
        const layer = await pack(LAYER_FILES, LAYER_HIVE);
        t.after(()=>Promise.all([bottle, layer].map(one=>one.cleanup())));
        const store = memoryStore();

        /** @param {string} id */
        const run = async id=>{
            const before = layer.fetched.bytes;
            const { observed } = await observe({ fetch: bottle.fetch, store, id, prefetch: false,
                layers: [{ id: 'netfx48', fetch: layer.fetch, store, prefetch: false }] });
            return { observed, layerBytes: layer.fetched.bytes - before };
        };
        const first = await run('bottle-a');
        const second = await run('bottle-b');

        assert.deepEqual(second.observed, first.observed);
        assert.ok(first.layerBytes > CLR.length,
            `the first run fetched the layer (${first.layerBytes})`);
        assert.ok(second.layerBytes < CLR.length / 10,
            `the second bottle read the layer's blocks from the cache, fetching only its index `
            + `(${second.layerBytes})`);
        const tables = [...store.files.keys()].filter(path=>path.endsWith('.index')).sort();
        assert.equal(tables.length, 3, `${tables}`);
        assert.equal(tables.filter(path=>path.startsWith('netfx48-')).length, 1,
            'one cache of the layer, named by it');
        assert.ok(tables.some(path=>path.startsWith('bottle-a-'))
            && tables.some(path=>path.startsWith('bottle-b-')), 'and one of each bottle');
    });

/** Somewhere to keep blocks, over ordinary buffers: Node has no OPFS. */
function memoryStore(){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @param {string} path @returns {Uint8Array} */
    const bytesOf = path=>files.get(path) ?? new Uint8Array(0);
    return {
        files,
        /** @param {string} path */
        async open(path){
            if (!files.has(path))
            {
                files.set(path, new Uint8Array(0));
            }
        },
        /** @param {string} path */
        stat: path=>(files.has(path) ? { size: bytesOf(path).length } : null),
        /** @param {string} path @param {number} at @param {number} length */
        read: (path, at, length)=>bytesOf(path).slice(at, at + length),
        /** @param {string} path @param {number} at @param {Uint8Array} bytes */
        write(path, at, bytes){
            const held = bytesOf(path);
            const grown = new Uint8Array(Math.max(held.length, at + bytes.length));
            grown.set(held);
            grown.set(bytes, at);
            files.set(path, grown);
        },
        /** @param {string} path @param {number} size */
        truncate(path, size){
            files.set(path, bytesOf(path).slice(0, size));
        },
        /** @param {string} path */
        remove(path){
            files.delete(path);
        },
    };
}
