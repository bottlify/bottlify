/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPRESSION, decodeFolder, readCabinet } from './cabinet.js';
import { writeCabinet } from './fci.js';
import { createCabinetFunctions } from './functions.js';

/** @param {number} length @param {number} seed */
const pattern = (length, seed)=>Uint8Array.from({ length },
    (_, at)=>(at * seed + (at >> 7)) & 0xff);

test('a cabinet written reads back: folders, files, every block\'s checksum', async()=>{
    const big = pattern(70000, 3);
    const small = pattern(1000, 5);
    for (const compression of [COMPRESSION.NONE, COMPRESSION.MSZIP])
    {
        const bytes = await writeCabinet({ setID: 0xbeef, iCabinet: 1,
            reserve: { header: 6, folder: 2, data: 1 },
            folders: [
                { compression, files: [
                    { name: 'big.bin', data: big, date: 0x5a21, time: 0x6000, attribs: 0x20 },
                    { name: 'empty.txt', data: new Uint8Array(0), date: 0, time: 0,
                        attribs: 0 }] },
                { compression: COMPRESSION.NONE, files: [
                    { name: 'dir\\small.bin', data: small, date: 1, time: 2, attribs: 0x40 }] },
            ] });
        const cabinet = readCabinet(bytes);
        assert.deepEqual(cabinet.files.map(file=>[file.name, file.size, file.folder]),
            [['big.bin', 70000, 0], ['empty.txt', 0, 0], ['dir\\small.bin', 1000, 1]]);
        assert.deepEqual(decodeFolder(cabinet, 0), big, `compression ${compression}`);
        assert.deepEqual(decodeFolder(cabinet, 1), small);
        assert.equal(new DataView(bytes.buffer).getUint32(8, true), bytes.length, 'cbCabinet');
    }
    const packed = await writeCabinet({ setID: 1, iCabinet: 0, folders: [
        { compression: COMPRESSION.MSZIP, files: [{ name: 'z', data: new Uint8Array(65536),
            date: 0, time: 0, attribs: 0 }] }] });
    assert.ok(packed.length < 1000, 'MSZIP compresses');
});

test('FCI makes a cabinet through the program\'s callbacks, and FDI extracts it', async()=>{
    // Wine's setupapi install create_cab_file, then FDICopy over the result.
    const memory = new Uint8Array(0x400000);
    const view = new DataView(memory.buffer);
    let top = 0x10000;
    /** @param {number} at */
    const text = at=>{
        let end = at;
        while (memory[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...memory.subarray(at, end));
    };
    /** @param {string} value */
    const put = value=>{
        const at = top;
        memory.set([...value, '\0'].map(c=>c.charCodeAt(0)), at);
        top += value.length + 16;
        return at;
    };
    /** The program's files, by name, and its open handles. @type {Map<string, Uint8Array>} */
    const disk = new Map([['C:\\src\\one.txt', pattern(50000, 7)],
        ['C:\\src\\two.txt', pattern(10, 9)]]);
    /** @type {Map<number, { name: string, at: number, out: number[] | null }>} */
    const open = new Map();
    let nextFile = 5;
    /** @type {string[]} */
    const placed = [];
    const E = { placed: 1, alloc: 2, free: 3, open: 4, read: 5, write: 6, close: 7, seek: 8,
        remove: 9, temp: 10, next: 11, progress: 12, openInfo: 13, notify: 14 };
    /** @param {string} name @param {boolean} writing */
    const opened = (name, writing)=>{
        const handle = nextFile++;
        open.set(handle, { name, at: 0, out: writing ? [] : null });
        return handle;
    };
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        readCString: (/** @type {number} */ at)=>text(at),
        allocate: (/** @type {number} */ bytes)=>{
            const at = top;
            top += (bytes + 15) & ~15;
            return at;
        },
        free: ()=>{},
        callerThread: ()=>({}),
        call: (/** @type {number} */ entry, /** @type {number[]} */ args)=>{
            switch (entry)
            {
                case E.placed:
                    placed.push(text(args[1]));
                    return 0;
                case E.openInfo:
                    view.setUint16(args[1], 0x5a21, true);
                    view.setUint16(args[2], 0x6000, true);
                    view.setUint16(args[3], 0x20, true);
                    return disk.has(text(args[0])) ? opened(text(args[0]), false) : -1;
                case E.open:
                {
                    const name = text(args[0]);
                    return (args[1] & 0x0100) !== 0 ? opened(name, true)
                        : disk.has(name) ? opened(name, false) : -1;
                }
                case E.read:
                {
                    const file = open.get(args[0]);
                    const data = disk.get(file?.name ?? '') ?? new Uint8Array(0);
                    const part = data.subarray(file?.at ?? 0, (file?.at ?? 0) + args[2]);
                    memory.set(part, args[1]);
                    if (file)
                    {
                        file.at += part.length;
                    }
                    return part.length;
                }
                case E.write:
                {
                    const file = open.get(args[0]);
                    file?.out?.push(...memory.subarray(args[1], args[1] + args[2]));
                    return args[2];
                }
                case E.seek:
                {
                    const file = open.get(args[0]);
                    const size = disk.get(file?.name ?? '')?.length ?? 0;
                    const at = args[2] === 2 ? size + (args[1] | 0) : args[2] === 1
                        ? (file?.at ?? 0) + (args[1] | 0) : args[1];
                    if (file)
                    {
                        file.at = at;
                    }
                    return at;
                }
                case E.close:
                {
                    const file = open.get(args[0]);
                    if (file?.out)
                    {
                        disk.set(file.name, Uint8Array.from(file.out));
                    }
                    open.delete(args[0]);
                    return 0;
                }
                case E.notify:
                {
                    if (args[0] === 3)
                    {
                        // fdintCLOSE_FILE_INFO: the program closes what it wrote.
                        const handle = view.getInt32(args[1] + 20, true);
                        const file = open.get(handle);
                        disk.set(file?.name ?? '', Uint8Array.from(file?.out ?? []));
                        open.delete(handle);
                        return 1;
                    }
                    if (args[0] !== 2)
                    {
                        return 1;
                    }
                    const name = text(view.getUint32(args[1] + 4, true));
                    const handle = opened(`out\\${name}`, true);
                    return handle;
                }
                default:
                    return 0;
            }
        },
    };
    const fns = /** @type {Record<string, any>} */ (createCabinetFunctions(host));
    const erf = 0x100;
    const ccab = 0x400;
    view.setUint32(ccab, 0x7fffffff, true);
    view.setUint32(ccab + 4, 900000, true);
    view.setInt32(ccab + 20, 1, true);
    view.setUint16(ccab + 32, 0xbeef, true);
    memory.set([...'made.cab\0'].map(c=>c.charCodeAt(0)), ccab + 290);
    memory.set([...'C:\\cabs\\\0'].map(c=>c.charCodeAt(0)), ccab + 546);
    assert.equal(fns.FCICreate.handler([0, E.placed, E.alloc, E.free, E.open, E.read, E.write,
        E.close, E.seek, E.remove, E.temp, ccab, 0]), 0, 'no ERF');
    const fci = fns.FCICreate.handler([erf, E.placed, E.alloc, E.free, E.open, E.read, E.write,
        E.close, E.seek, E.remove, E.temp, ccab, 0]);
    assert.notEqual(fci, 0);
    for (const name of ['one.txt', 'two.txt'])
    {
        assert.equal(await fns.FCIAddFile.handler([fci, put(`C:\\src\\${name}`), put(name), 0,
            E.next, E.progress, E.openInfo, COMPRESSION.MSZIP]), 1, name);
    }
    assert.equal(await fns.FCIAddFile.handler([fci, put('C:\\src\\none.txt'), put('none.txt'), 0,
        E.next, E.progress, E.openInfo, COMPRESSION.MSZIP]), 0);
    assert.equal(view.getUint32(erf, true), 1, 'FCIERR_OPEN_SRC');
    assert.equal(await fns.FCIAddFile.handler([fci, put('C:\\src\\one.txt'), put('x'), 0, E.next,
        E.progress, E.openInfo, COMPRESSION.LZX]), 0);
    assert.equal(view.getUint32(erf, true), 5, 'FCIERR_BAD_COMPR_TYPE');
    assert.equal(await fns.FCIFlushCabinet.handler([fci, 0, E.next, E.progress]), 1);
    assert.equal(fns.FCIDestroy.handler([fci]), 1);
    assert.equal(fns.FCIDestroy.handler([fci]), 0, 'once');
    assert.deepEqual(placed, ['one.txt', 'two.txt']);
    const cabinet = disk.get('C:\\cabs\\made.cab');
    assert.ok(cabinet, 'written where CCAB says');

    const fdi = fns.FDICreate.handler([E.alloc, E.free, E.open, E.read, E.write, E.close,
        E.seek, 1, erf]);
    assert.equal(await fns.FDICopy.handler([fdi, put('made.cab'), put('C:\\cabs\\'), 0, E.notify,
        0, 0]), 1);
    /** @param {Uint8Array | undefined} a @param {Uint8Array} b */
    const same = (a, b)=>a !== undefined && a.length === b.length && a.every((v, i)=>v === b[i]);
    assert.ok(same(disk.get('out\\one.txt'), pattern(50000, 7)), 'one.txt extracted whole');
    assert.ok(same(disk.get('out\\two.txt'), pattern(10, 9)), 'two.txt extracted whole');
});
