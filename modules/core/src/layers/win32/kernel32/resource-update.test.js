/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * BeginUpdateResource, UpdateResource and EndUpdateResource on the images
 * kernel32's resource tests build: what the section table looks like after
 * each kind of update, and that the loader's own resource reader finds what
 * was written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceUpdates, peChecksum } from './resource-update.js';
import { parsePe } from '../../loader/internal/pe.js';
import { findResource, listResources } from '../../loader/internal/resources.js';

const PAGE = 0x1000;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_FILE_INVALID = 1006;

/** IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ. */
const DATA = 0x40000040;

/**
 * @typedef {{ name: string, va: number, vsize: number, raw: number, rawSize: number }} Section
 */

/**
 * An image as the tests build one: the headers in the first page, one data
 * directory -- the resources, at 0x3000 for a page -- and zero pages for the
 * sections.
 *
 * @param {Section[]} sections
 * @param {{ checksum?: number, overlay?: number[], directories?: Record<number, number>,
 *     resources?: number }} [extra]
 */
function image(sections, extra = {}){
    const { checksum = 0, overlay = [], directories = {}, resources = 3 * PAGE } = extra;
    const size = Math.max(PAGE, ...sections.map(section=>section.raw + section.rawSize));
    const bytes = new Uint8Array(size + overlay.length);
    bytes.set(overlay, size);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x40, true);
    view.setUint32(0x40, 0x4550, true);
    view.setUint16(0x44, 0x14c, true);
    view.setUint16(0x46, sections.length, true);
    view.setUint16(0x54, 0xe0, true);
    view.setUint16(0x56, 0x2102, true);
    const optional = 0x58;
    view.setUint16(optional, 0x10b, true);
    view.setUint32(optional + 28, 0x10000000, true);
    view.setUint32(optional + 32, PAGE, true);
    view.setUint32(optional + 36, PAGE, true);
    view.setUint32(optional + 56, Math.max(PAGE, ...sections.map(section=>
        section.va + section.vsize)), true);
    view.setUint32(optional + 60, 0x200, true);
    view.setUint32(optional + 64, checksum, true);
    view.setUint32(optional + 92, 16, true);
    view.setUint32(optional + 96 + 2 * 8, resources, true);
    view.setUint32(optional + 96 + 2 * 8 + 4, PAGE, true);
    for (const [at, rva] of Object.entries(directories))
    {
        view.setUint32(optional + 96 + Number(at) * 8, rva, true);
        view.setUint32(optional + 96 + Number(at) * 8 + 4, 0x10, true);
    }
    sections.forEach((section, at)=>{
        const header = optional + 0xe0 + at * 40;
        bytes.set([...section.name].map(c=>c.charCodeAt(0)), header);
        view.setUint32(header + 8, section.vsize, true);
        view.setUint32(header + 12, section.va, true);
        view.setUint32(header + 16, section.rawSize, true);
        view.setUint32(header + 20, section.raw, true);
        view.setUint32(header + 36, DATA, true);
    });
    return bytes;
}

/** @param {string} name @param {number} at @param {number} pages @param {number} [rawSize] */
const section = (name, at, pages, rawSize = pages * PAGE)=>({
    name, va: at, vsize: pages * PAGE, raw: at, rawSize,
});

function setup(){
    /** @type {Map<string, Uint8Array>} */
    const disk = new Map();
    const memory = new Uint8Array(0x14000);
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let next = 0x40;
    /** @type {number[]} */
    const errors = [];
    const fns = /** @type {any} */ (createResourceUpdates({
        files: /** @type {any} */ ({
            stat: (/** @type {string} */ path)=>(disk.has(path)
                ? { exists: true, isDirectory: false,
                    size: /** @type {Uint8Array} */ (disk.get(path)).length }
                : null),
            open: (/** @type {string} */ path, /** @type {any} */ mode)=>{
                if (!disk.has(path) && !mode.create)
                {
                    return null;
                }
                if (mode.truncate)
                {
                    disk.set(path, new Uint8Array(0));
                }
                return { path };
            },
            read: (/** @type {any} */ node, /** @type {number} */ at, /** @type {number} */ n)=>
                /** @type {Uint8Array} */ (disk.get(node.path)).slice(at, at + n),
            /** @param {any} node @param {number} at @param {Uint8Array} data */
            write: (node, at, data)=>{
                const old = /** @type {Uint8Array} */ (disk.get(node.path));
                const grown = new Uint8Array(Math.max(old.length, at + data.length));
                grown.set(old);
                grown.set(data, at);
                disk.set(node.path, grown);
                return data.length;
            },
            close: ()=>{},
        }),
        fullPath: name=>(name.includes('\\') ? name : `C:\\WORK\\${name}`),
        readMemory: (at, length)=>memory.slice(at, at + length),
        readCString: at=>{
            let text = '';
            for (let i = at; memory[i] !== 0; i++)
            {
                text += String.fromCharCode(memory[i]);
            }
            return text;
        },
        readWideString: at=>{
            let text = '';
            for (let i = at; memory[i] | memory[i + 1]; i += 2)
            {
                text += String.fromCharCode(memory[i] | memory[i + 1] << 8);
            }
            return text;
        },
        setLastError: code=>errors.push(code),
        handles: {
            open: (type, object)=>{
                const handle = next;
                next += 4;
                table.set(handle, { type, object });
                return handle;
            },
            resolve: (handle, type)=>{
                const held = table.get(handle);
                if (!held || (type && held.type !== type))
                {
                    throw new Error('bad handle');
                }
                return held.object;
            },
            close: handle=>table.delete(handle),
        },
    }));
    /** @param {number} at @param {string} text */
    const ansi = (at, text)=>{
        memory.set([...text].map(c=>c.charCodeAt(0)).concat(0), at);
        return at;
    };
    /** @param {number} at @param {number[]} data */
    const put = (at, data)=>{
        memory.set(data, at);
        return at;
    };
    const NAME = ansi(0x100, 'test_.exe');
    const PATH = 'C:\\WORK\\test_.exe';
    /** The image on the disk, read the way the loader reads one. */
    const onDisk = ()=>{
        const bytes = /** @type {Uint8Array} */ (disk.get(PATH));
        return { bytes, pe: parsePe(bytes), view: new DataView(bytes.buffer) };
    };
    return { fns, disk, errors, ansi, put, NAME, PATH, onDisk };
}

/** @param {any} pe @param {Uint8Array} bytes */
const rootCounts = (pe, bytes)=>{
    const view = new DataView(bytes.buffer);
    const rsrc = pe.directories[2].address;
    const owner = pe.sections.find((/** @type {any} */ s)=>
        rsrc >= s.virtualAddress && rsrc < s.virtualAddress + s.rawSize);
    const at = owner.rawOffset + rsrc - owner.virtualAddress;
    return {
        version: [view.getUint16(at + 8, true), view.getUint16(at + 10, true)],
        stamp: view.getUint32(at + 4, true),
        named: view.getUint16(at + 12, true),
        ids: view.getUint16(at + 14, true),
    };
};

test('a resource added to the last section is found by the loader, the section grown in place',
    ()=>{
        const { fns, disk, PATH, NAME, put, onDisk } = setup();
        disk.set(PATH, image([section('.rodata', PAGE, 2), section('.rsrc', 3 * PAGE, 1)]));
        const handle = fns.BeginUpdateResourceA.handler([NAME, 1]);
        assert.ok(handle > 0);
        const text = put(0x400, [...'red and white'].map(c=>c.charCodeAt(0)).concat(0));
        assert.equal(fns.UpdateResourceA.handler([handle, 0x1230, 0x4567, 0xabcd, text, 14]), 1);
        assert.equal(fns.EndUpdateResourceA.handler([handle, 0]), 1);

        let { bytes, pe } = onDisk();
        assert.deepEqual(pe.sections.map((/** @type {any} */ s)=>[s.name, s.virtualAddress,
            s.rawOffset]), [['.rodata', PAGE, PAGE], ['.rsrc', 3 * PAGE, 3 * PAGE]]);
        assert.equal(pe.directories[2].address, 3 * PAGE, 'the directory at the section');
        assert.deepEqual(rootCounts(pe, bytes), { version: [4, 0], stamp: 0, named: 0, ids: 1 });
        const found = findResource(bytes, pe, 0x1230, 0x4567, 0xabcd);
        assert.ok(found);
        assert.equal(found.size, 14);

        // Big data grows the section, and the image with it.
        const big = setup();
        big.disk.set(big.PATH, bytes);
        const again = big.fns.BeginUpdateResourceA.handler([big.NAME, 1]);
        big.put(0x1000, new Array(2 * PAGE).fill(7));
        big.fns.UpdateResourceA.handler([again, 0x3012, 0x5647, 0xcdba, 0x1000, 2 * PAGE]);
        assert.equal(big.fns.EndUpdateResourceA.handler([again, 0]), 1);
        ({ bytes, pe } = big.onDisk());
        assert.equal(pe.sections[1].virtualAddress, 3 * PAGE);
        assert.equal(pe.sections[1].rawSize, 3 * PAGE, 'grown to whole pages');
        assert.equal(pe.sizeOfImage, 6 * PAGE);
        assert.ok(bytes.length >= 6 * PAGE);
        assert.equal(findResource(bytes, pe, 0x1230, 0x4567, 0xabcd), null,
            'the old ones were dropped as asked');
    });

test('a directory pointing at the section\'s end is moved to its start', ()=>{
    const { fns, disk, PATH, NAME, onDisk } = setup();
    disk.set(PATH, image([section('.rodata', PAGE, 1), section('.rsrc', 2 * PAGE, 2)]));
    const handle = fns.BeginUpdateResourceA.handler([NAME, 1]);
    assert.equal(fns.EndUpdateResourceA.handler([handle, 0]), 1);
    const { bytes, pe } = onDisk();
    assert.equal(pe.directories[2].address, 2 * PAGE);
    assert.equal(pe.sections[1].virtualAddress, 2 * PAGE);
    assert.deepEqual(rootCounts(pe, bytes).ids, 0, 'an empty directory, written');
});

test('a section after the resource one moves down by what it grew, and its directory too', ()=>{
    const { fns, disk, PATH, NAME, put, onDisk } = setup();
    disk.set(PATH, image([section('.rodata', PAGE, 2), section('.rsrc', 3 * PAGE, 1),
        section('.reloc', 4 * PAGE, 1)], { directories: { 5: 4 * PAGE + 0x10 } }));
    /** @type {Uint8Array} */ (disk.get(PATH)).set([0xaa, 0xbb], 4 * PAGE);
    const handle = fns.BeginUpdateResourceA.handler([NAME, 1]);
    put(0x1000, new Array(2 * PAGE).fill(1));
    fns.UpdateResourceA.handler([handle, 0x3012, 0x5647, 0xcdba, 0x1000, 2 * PAGE]);
    assert.equal(fns.EndUpdateResourceA.handler([handle, 0]), 1);
    const { bytes, pe } = onDisk();
    assert.deepEqual(pe.sections.map((/** @type {any} */ s)=>[s.name, s.virtualAddress,
        s.rawOffset]), [['.rodata', PAGE, PAGE], ['.rsrc', 3 * PAGE, 3 * PAGE],
        ['.reloc', 6 * PAGE, 6 * PAGE]]);
    assert.deepEqual([...bytes.subarray(6 * PAGE, 6 * PAGE + 2)], [0xaa, 0xbb],
        'its bytes moved with it');
    assert.equal(pe.directories[5].address, 6 * PAGE + 0x10);
    assert.equal(pe.sizeOfImage, 7 * PAGE);
});

test('named resources come first, kept in upper case, and are found by name', ()=>{
    const { fns, disk, PATH, NAME, ansi, put, onDisk } = setup();
    disk.set(PATH, image([section('.rodata', PAGE, 2), section('.rsrc', 3 * PAGE, 1)]));
    const handle = fns.BeginUpdateResourceA.handler([NAME, 1]);
    const data = put(0x400, [1, 2, 3, 4, 5]);
    // Strings are pointers above the first 64 KiB; below it a value is a number.
    fns.UpdateResourceA.handler([handle, ansi(0x10200, 'type'), ansi(0x10220, 'name'), 0,
        data, 5]);
    fns.UpdateResourceA.handler([handle, 10, ansi(0x10240, '#7'), 0x409, data, 3]);
    assert.equal(fns.EndUpdateResourceA.handler([handle, 0]), 1);
    const { bytes, pe } = onDisk();
    assert.deepEqual(rootCounts(pe, bytes), { version: [4, 0], stamp: 0, named: 1, ids: 1 });
    assert.equal(findResource(bytes, pe, 'type', 'name', 0)?.size, 5);
    assert.equal(findResource(bytes, pe, 10, 7, 0x409)?.size, 3, '"#7" is the number 7');
    assert.deepEqual(listResources(bytes, pe).map(found=>[found.type, found.name]),
        [['TYPE', 'NAME'], [10, 7]]);
});

test('existing resources are kept, replaced by type, name and language, or deleted', ()=>{
    const first = setup();
    first.disk.set(first.PATH, image([section('.text', PAGE, 1), section('.rsrc', 2 * PAGE, 1)],
        { resources: 2 * PAGE }));
    const a = first.fns.BeginUpdateResourceA.handler([first.NAME, 0]);
    const data = first.put(0x400, [9, 9, 9, 9]);
    first.fns.UpdateResourceA.handler([a, 6, 1, 0x409, data, 4]);
    first.fns.UpdateResourceA.handler([a, 6, 2, 0x409, data, 2]);
    first.fns.EndUpdateResourceA.handler([a, 0]);

    const second = setup();
    second.disk.set(second.PATH, /** @type {Uint8Array} */ (first.disk.get(first.PATH)));
    const b = second.fns.BeginUpdateResourceA.handler([second.NAME, 0]);
    second.put(0x400, [5]);
    assert.equal(second.fns.UpdateResourceA.handler([b, 6, 1, 0x409, 0x400, 1]), 1);
    assert.equal(second.fns.UpdateResourceA.handler([b, 6, 2, 0x409, 0, 0]), 1, 'a delete');
    second.fns.EndUpdateResourceA.handler([b, 0]);
    const { bytes, pe } = second.onDisk();
    const one = findResource(bytes, pe, 6, 1, 0x409);
    assert.equal(one?.size, 1, 'replaced');
    assert.equal(findResource(bytes, pe, 6, 2, 0x409), null, 'deleted');
});

test('an image with no resource section gets one, and its tail stays after it', ()=>{
    const { fns, disk, PATH, NAME, put, onDisk } = setup();
    const plain = image([section('.text', PAGE, 1)], { overlay: [0x50, 0x4b, 3, 4],
        checksum: 0x1234 });
    new DataView(plain.buffer).setUint32(0x58 + 96 + 16, 0, true);
    disk.set(PATH, plain);
    const handle = fns.BeginUpdateResourceA.handler([NAME, 0]);
    fns.UpdateResourceA.handler([handle, 24, 1, 0, put(0x400, [0x3c, 0x3f]), 2]);
    assert.equal(fns.EndUpdateResourceA.handler([handle, 0]), 1);
    const { bytes, pe, view } = onDisk();
    assert.equal(pe.sections.length, 2);
    assert.equal(pe.sections[1].name, '.rsrc');
    assert.equal(pe.sections[1].virtualAddress, 2 * PAGE);
    assert.equal(pe.directories[2].address, 2 * PAGE);
    assert.equal(findResource(bytes, pe, 24, 1, 0)?.size, 2);
    assert.deepEqual([...bytes.subarray(bytes.length - 4)], [0x50, 0x4b, 3, 4], 'the tail kept');
    assert.equal(view.getUint32(0x58 + 64, true), peChecksum(bytes, 0x58 + 64),
        'a checksum made right');
});

test('Begin refuses what is not an image, End with discard writes nothing', ()=>{
    const { fns, disk, PATH, NAME, errors, put } = setup();
    assert.equal(fns.BeginUpdateResourceA.handler([NAME, 1]), 0);
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND);
    disk.set(PATH, new Uint8Array(0));
    assert.equal(fns.BeginUpdateResourceA.handler([NAME, 1]), 0);
    assert.equal(errors.at(-1), ERROR_FILE_INVALID, 'an empty file');
    disk.set(PATH, new Uint8Array(100).fill(0x41));
    assert.equal(fns.BeginUpdateResourceA.handler([NAME, 0]), 0);
    assert.equal(errors.at(-1), ERROR_BAD_EXE_FORMAT);

    const original = image([section('.rodata', PAGE, 2), section('.rsrc', 3 * PAGE, 1)]);
    disk.set(PATH, original);
    const wideName = put(0x600, [...'test_.exe'].flatMap(c=>[c.charCodeAt(0), 0]).concat([0, 0]));
    const wideHandle = fns.BeginUpdateResourceW.handler([wideName, 1]);
    assert.ok(wideHandle > 0, 'the W form finds the same file by its wide name');
    assert.equal(fns.EndUpdateResourceW.handler([wideHandle, 1]), 1);
    const h = fns.BeginUpdateResourceA.handler([NAME, 1]);
    assert.equal(fns.EndUpdateResourceA.handler([h, 1]), 1);
    assert.deepEqual(disk.get(PATH), original, 'discarded');
    assert.equal(fns.EndUpdateResourceA.handler([h, 0]), 0, 'and the handle is gone');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.UpdateResourceA.handler([h, 1, 1, 0, 0, 0]), 0);
    assert.deepEqual([fns.BeginUpdateResourceA.argBytes, fns.UpdateResourceA.argBytes,
        fns.EndUpdateResourceA.argBytes], [8, 24, 8]);
});
