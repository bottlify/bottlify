/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGuid, parseGuid } from './guid.js';
import { createComRegistry } from './objects.js';
import { parseCompoundFile, serializeCompoundFile, createRoot } from './cfb.js';
import {
    IID_IENUMSTATSTG, IID_ISEQUENTIALSTREAM, IID_ISTORAGE, IID_ISTREAM, STGM,
    createStorageFunctions,
} from './storage.js';

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
const STG_E_INVALIDFUNCTION = 0x80030001 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const STG_E_ACCESSDENIED = 0x80030005 | 0;
const STG_E_READFAULT = 0x8003001e | 0;
const STG_E_FILEALREADYEXISTS = 0x80030050 | 0;
const STG_E_INVALIDNAME = 0x800300fc | 0;
const STG_E_INVALIDFLAG = 0x800300ff | 0;

const STGM_SHARE_DENY_NONE = 0x40;
const STGM_CONVERT = 0x20000;
const STATFLAG_NONAME = 1;
const STGTY_STORAGE = 1;
const STGTY_STREAM = 2;
const STGMOVE_COPY = 1;

const CREATE_MODE = STGM.READWRITE | STGM.SHARE_EXCLUSIVE | STGM.CREATE;
const RW = STGM.READWRITE | STGM.SHARE_EXCLUSIVE;
const RO = STGM.READ | STGM.SHARE_EXCLUSIVE;

const CLSID_A = '{12345678-9ABC-DEF0-1234-56789ABCDEF0}';
const PATH = 'C:\\App\\object.stg';

/** Guest addresses the fixtures use. */
const NAME = 0x1000;
const NAME2 = 0x1200;
const OUT = 0x1400;
const OUT2 = 0x1410;
const OUT3 = 0x1420;
const BUFFER = 0x2000;
const STAT = 0x3000;
const GUID_AT = 0x3100;
const COUNT = 0x3200;
const COUNT2 = 0x3210;
/** Where the fake guest's own object lives: its vtable, then the object. */
const GUEST_VTABLE = 0x4000;
const GUEST_OBJECT = 0x4100;

function fakeHeap(base = 0x8000){
    /** @type {Map<number, { size: number, capacity: number }>} */
    const live = new Map();
    let next = base;
    return {
        live,
        /** @param {number} bytes */
        allocate(bytes){
            const address = next;
            const capacity = Math.max(8, bytes);
            next += capacity + 16;
            live.set(address, { size: bytes, capacity });
            return address;
        },
        /** @param {number} address */
        free: address=>live.delete(address),
        /** @param {number} address */
        block: address=>live.get(address) ?? null,
        /** @param {number} address @param {number} bytes */
        resize(address, bytes){
            const block = live.get(address);
            if (!block || bytes > block.capacity)
            {
                return false;
            }
            block.size = bytes;
            return true;
        },
    };
}

/** A volume of whole files, which is all a docfile asks of one. */
function fakeFiles(){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    return {
        files,
        /** @param {string} path */
        stat: path=>{
            const bytes = files.get(path.toUpperCase());
            return bytes ? { exists: true, isDirectory: false, size: bytes.length } : null;
        },
        /** @param {string} path @param {{ create?: boolean, truncate?: boolean }} mode */
        open(path, mode){
            const key = path.toUpperCase();
            if (!files.has(key) && !mode.create)
            {
                return null;
            }
            if (mode.truncate || !files.has(key))
            {
                files.set(key, new Uint8Array(0));
            }
            return { key };
        },
        /** @param {{ key: string }} node @param {number} offset @param {number} length */
        read: (node, offset, length)=>{
            const bytes = /** @type {Uint8Array} */ (files.get(node.key));
            return bytes.slice(offset, offset + length);
        },
        /** @param {{ key: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const existing = /** @type {Uint8Array} */ (files.get(node.key));
            const grown = new Uint8Array(Math.max(existing.length, offset + bytes.length));
            grown.set(existing);
            grown.set(bytes, offset);
            files.set(node.key, grown);
            return bytes.length;
        },
        close: ()=>{},
        /** @param {string} path */
        remove: path=>files.delete(path.toUpperCase()),
    };
}

function setup(){
    const bytes = new Uint8Array(0x40000);
    /** @type {string[]} */
    const reported = [];
    /** @type {Map<any, number>} */
    const published = new Map();
    /** @type {Map<number, any>} */
    const records = new Map();
    let nextPointer = 0x20000;
    /**
     * What the fake guest does when called at an address: the entries of
     * the guest object's vtable.
     *
     * @type {Map<number, (args: number[]) => number>}
     */
    const guestEntries = new Map();
    /** @type {string[]} */
    const guestCalls = [];

    const host = {
        bytes,
        reported,
        heap: fakeHeap(),
        registry: createComRegistry(),
        files: fakeFiles(),
        vtables: {
            /** @param {any} object @param {string} interfaceId */
            publish(object, interfaceId){
                const record = object.interfaceFor(interfaceId);
                if (!record)
                {
                    return 0;
                }
                const existing = published.get(record);
                if (existing)
                {
                    return existing;
                }
                nextPointer += 0x100;
                published.set(record, nextPointer);
                records.set(nextPointer, record);
                return nextPointer;
            },
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
        /** @param {number} entry @param {number[]} args */
        call: (entry, args)=>{
            const fn = guestEntries.get(entry);
            if (!fn)
            {
                return Promise.reject(new Error(`no guest code at 0x${entry.toString(16)}`));
            }
            guestCalls.push(`${entry.toString(16)}(${args.map(a=>a.toString(16)).join(',')})`);
            return Promise.resolve(fn(args));
        },
        guestCalls,
        /** @param {number} address */
        u32(address){
            return (bytes[address] | (bytes[address + 1] << 8)
                | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0;
        },
        /** @param {number} address @param {number} value */
        putU32(address, value){
            new DataView(bytes.buffer).setUint32(address, value >>> 0, true);
        },
        /** @param {number} address @param {string} text  Written as UTF-16. */
        putWide(address, text){
            for (let index = 0; index < text.length; index++)
            {
                bytes[address + index * 2] = text.charCodeAt(index) & 0xff;
                bytes[address + index * 2 + 1] = (text.charCodeAt(index) >>> 8) & 0xff;
            }
            bytes[address + text.length * 2] = 0;
            bytes[address + text.length * 2 + 1] = 0;
            return address;
        },
        /** @param {number} address */
        readWide(address){
            let text = '';
            for (let at = address; ; at += 2)
            {
                const unit = bytes[at] | (bytes[at + 1] << 8);
                if (unit === 0)
                {
                    return text;
                }
                text += String.fromCharCode(unit);
            }
        },
        /** @param {number} address @param {string} guid */
        putGuid(address, guid){
            bytes.set(/** @type {Uint8Array} */ (parseGuid(guid)), address);
            return address;
        },
        /**
         * Calls a method through an interface pointer this fake published.
         *
         * @param {number} pointer @param {string} name @param {number[]} args
         * @returns {number | Promise<number>}
         */
        call_(pointer, name, args){
            const record = records.get(pointer);
            assert.ok(record, `no interface at 0x${pointer.toString(16)}`);
            const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method, `${name} is not in the table`);
            return method.invoke(record.object, args);
        },
        /** @param {number} pointer */
        release(pointer){
            const record = records.get(pointer);
            assert.ok(record);
            return record.object.release();
        },
        /** @param {number} pointer */
        methodNames(pointer){
            return records.get(pointer).methods.map((/** @type {any} */ m)=>[m.name, m.argBytes]);
        },
        /** @param {number} pointer */
        objectAt(pointer){
            const record = records.get(pointer);
            return record && !record.object.destroyed ? record.object : undefined;
        },
        /**
         * Puts an object of the guest's own into memory: a vtable of entry
         * addresses and an object pointing at it.
         *
         * @param {((args: number[]) => number)[]} slots
         */
        guestObject(slots){
            slots.forEach((fn, index)=>{
                const entry = 0x5000 + index * 0x10;
                guestEntries.set(entry, fn);
                host.putU32(GUEST_VTABLE + index * 4, entry);
            });
            host.putU32(GUEST_OBJECT, GUEST_VTABLE);
            return GUEST_OBJECT;
        },
        /** The docfile at PATH, parsed. */
        document: ()=>parseCompoundFile(
            /** @type {Uint8Array} */ (host.files.files.get(PATH.toUpperCase()))),
    };
    const fns = createStorageFunctions(host);
    /** @type {(pointer: number, name: string, args: number[]) => any} */
    const call = (pointer, name, args)=>host.call_(pointer, name, args);

    /** A docfile at PATH with its root open read-write. */
    const createDocfile = ()=>{
        host.putWide(NAME, PATH);
        assert.equal(fns.StgCreateDocfile.handler([NAME, CREATE_MODE, 0, OUT]), S_OK);
        return host.u32(OUT);
    };
    /** @param {number} storage @param {string} name @param {number} [mode] */
    const createStream = (storage, name, mode = RW)=>{
        host.putWide(NAME, name);
        assert.equal(call(storage, 'CreateStream', [NAME, mode, 0, 0, OUT2]), S_OK);
        return host.u32(OUT2);
    };
    /** @param {number} stream @param {Uint8Array} data */
    const write = (stream, data)=>{
        bytes.set(data, BUFFER);
        assert.equal(call(stream, 'Write', [BUFFER, data.length, COUNT]), S_OK);
        assert.equal(host.u32(COUNT), data.length);
    };
    /** @param {number} stream @param {number} length */
    const read = (stream, length)=>{
        assert.equal(call(stream, 'Read', [BUFFER, length, COUNT]), S_OK);
        return bytes.slice(BUFFER, BUFFER + host.u32(COUNT));
    };
    return { host, fns, call, createDocfile, createStream, write, read };
}

test('StgCreateDocfile makes the file at once and hands out an IStorage over it', ()=>{
    const { host, fns, call, createDocfile } = setup();
    const root = createDocfile();
    assert.notEqual(root, 0);
    const document = host.document();
    assert.ok(document, 'an empty docfile is on the volume already');
    assert.equal(document.children.size, 0);

    assert.equal(call(root, 'Stat', [STAT, 0]), S_OK);
    assert.equal(host.readWide(host.u32(STAT)), PATH, 'the root is named by its path');
    assert.ok(host.heap.block(host.u32(STAT)), 'from task memory');
    assert.equal(host.u32(STAT + 4), STGTY_STORAGE);
    assert.equal(host.u32(STAT + 40), CREATE_MODE);
    assert.equal(call(root, 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(host.u32(STAT), 0, 'no name when none was asked for');

    assert.equal(fns.StgCreateDocfile.handler([NAME, CREATE_MODE, 0, 0]), 0x80030009 | 0,
        'STG_E_INVALIDPOINTER for nowhere to put it');
});

test('streams and storages written through the objects come back through the file', ()=>{
    const { host, fns, call, createDocfile, createStream, write, read } = setup();
    const root = createDocfile();
    host.putGuid(GUID_AT, CLSID_A);
    assert.equal(call(root, 'SetClass', [GUID_AT]), S_OK);
    assert.equal(call(root, 'SetStateBits', [0x5, 0xf]), S_OK);

    const small = createStream(root, 'Small');
    write(small, new Uint8Array(100).map((_, index)=>index));
    const big = createStream(root, 'Big');
    write(big, new Uint8Array(5000).fill(7));

    host.putWide(NAME, 'Sub');
    assert.equal(call(root, 'CreateStorage', [NAME, RW, 0, 0, OUT2]), S_OK);
    const sub = host.u32(OUT2);
    const inner = createStream(sub, 'inner');
    write(inner, Uint8Array.of(1, 2, 3));

    // Nothing is on the volume until a commit...
    assert.equal(host.document()?.children.size, 0);
    assert.equal(call(root, 'Commit', [0]), S_OK);
    const committed = host.document();
    assert.equal(committed?.clsid, CLSID_A);
    assert.equal(committed?.stateBits, 5);
    assert.equal(committed?.children.get('BIG')?.data.length, 5000);
    assert.deepEqual(committed?.children.get('SUB')?.children.get('INNER')?.data,
        Uint8Array.of(1, 2, 3));

    // ...and a write after it is on the volume once the last object goes.
    write(inner, Uint8Array.of(4));
    for (const pointer of [inner, sub, big, small])
    {
        assert.equal(host.release(pointer), 0);
    }
    assert.deepEqual(host.document()?.children.get('SUB')?.children.get('INNER')?.data,
        Uint8Array.of(1, 2, 3), 'the root still holds the document open');
    assert.equal(host.release(root), 0);
    assert.deepEqual(host.document()?.children.get('SUB')?.children.get('INNER')?.data,
        Uint8Array.of(1, 2, 3, 4));

    // Reopened, read through OpenStorage and OpenStream.
    host.putWide(NAME, PATH);
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RO, 0, 0, OUT]), S_OK);
    const reopened = host.u32(OUT);
    host.putWide(NAME, 'sub');
    assert.equal(call(reopened, 'OpenStorage', [NAME, 0, RO, 0, 0, OUT2]), S_OK,
        'names are found without regard to case');
    host.putWide(NAME, 'INNER');
    assert.equal(call(host.u32(OUT2), 'OpenStream', [NAME, 0, RO, 0, OUT3]), S_OK);
    assert.deepEqual(read(host.u32(OUT3), 100), Uint8Array.of(1, 2, 3, 4));
    assert.equal(call(reopened, 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(STAT + 48, STAT + 64)), CLSID_A);
});

test('a stream reads short at its end, seeks from three origins, grows and shrinks', ()=>{
    const { host, call, createDocfile, createStream, write, read } = setup();
    const root = createDocfile();
    const stream = createStream(root, 's');
    write(stream, Uint8Array.of(1, 2, 3, 4, 5));
    assert.equal(call(stream, 'Seek', [0, 0, 0, OUT]), S_OK, 'STREAM_SEEK_SET 0');
    assert.deepEqual(read(stream, 3), Uint8Array.of(1, 2, 3));
    assert.deepEqual(read(stream, 10), Uint8Array.of(4, 5), 'short, and S_OK');
    assert.deepEqual(read(stream, 10), new Uint8Array(0));

    assert.equal(call(stream, 'Seek', [-2 >>> 0, 0xffffffff, 2, OUT]), S_OK, 'END - 2');
    assert.equal(host.u32(OUT), 3);
    assert.equal(host.u32(OUT + 4), 0);
    assert.equal(call(stream, 'Seek', [-1 >>> 0, 0xffffffff, 1, OUT]), S_OK, 'CUR - 1');
    assert.equal(host.u32(OUT), 2);
    assert.equal(call(stream, 'Seek', [-3 >>> 0, 0xffffffff, 1, OUT]), STG_E_INVALIDFUNCTION,
        'before the start');
    assert.equal(call(stream, 'Seek', [0, 0, 7, OUT]), STG_E_INVALIDFUNCTION, 'no such origin');

    // A write past the end zero-fills the gap.
    assert.equal(call(stream, 'Seek', [8, 0, 0, 0]), S_OK);
    write(stream, Uint8Array.of(9));
    assert.equal(call(stream, 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(host.u32(STAT + 8), 9);
    assert.equal(host.u32(STAT + 4), STGTY_STREAM);
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.deepEqual(read(stream, 9), Uint8Array.of(1, 2, 3, 4, 5, 0, 0, 0, 9));

    assert.equal(call(stream, 'SetSize', [2, 0]), S_OK);
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.deepEqual(read(stream, 9), Uint8Array.of(1, 2));
    assert.equal(call(stream, 'SetSize', [4, 0]), S_OK);
    assert.deepEqual(read(stream, 9), Uint8Array.of(0, 0));

    assert.equal(call(stream, 'LockRegion', [0, 0, 1, 0, 0]), STG_E_INVALIDFUNCTION);
    assert.equal(call(stream, 'UnlockRegion', [0, 0, 1, 0, 0]), STG_E_INVALIDFUNCTION);
    assert.equal(call(stream, 'Commit', [0]), S_OK);
    assert.equal(call(stream, 'Revert', []), S_OK);

    // A clone shares the bytes and starts at the same position.
    assert.equal(call(stream, 'Seek', [1, 0, 0, 0]), S_OK);
    assert.equal(call(stream, 'Clone', [OUT]), S_OK);
    const clone = host.u32(OUT);
    assert.notEqual(clone, stream);
    assert.deepEqual(read(clone, 1), Uint8Array.of(2));
    write(clone, Uint8Array.of(0x55));
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.deepEqual(read(stream, 4), Uint8Array.of(1, 2, 0x55, 0));
});

test('access follows the mode: a read-only storage and a write-only stream refuse the other', ()=>{
    const { host, fns, call, createDocfile, createStream, write } = setup();
    const root = createDocfile();
    const stream = createStream(root, 's');
    write(stream, Uint8Array.of(1));
    host.release(stream);
    host.release(root);

    host.putWide(NAME, PATH);
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RO, 0, 0, OUT]), S_OK);
    const readOnly = host.u32(OUT);
    host.putWide(NAME, 't');
    assert.equal(call(readOnly, 'CreateStream', [NAME, RW, 0, 0, OUT2]), STG_E_ACCESSDENIED);
    assert.equal(call(readOnly, 'CreateStorage', [NAME, RO, 0, 0, OUT2]), STG_E_ACCESSDENIED);
    assert.equal(call(readOnly, 'DestroyElement', [NAME]), STG_E_ACCESSDENIED);
    assert.equal(call(readOnly, 'SetClass', [GUID_AT]), STG_E_ACCESSDENIED);
    host.putWide(NAME, 's');
    assert.equal(call(readOnly, 'OpenStream', [NAME, 0, RW, 0, OUT2]), STG_E_ACCESSDENIED,
        'a stream cannot be more writable than its storage');
    assert.equal(call(readOnly, 'OpenStream', [NAME, 0, RO, 0, OUT2]), S_OK);
    const stream2 = host.u32(OUT2);
    host.bytes[BUFFER] = 2;
    assert.equal(call(stream2, 'Write', [BUFFER, 1, COUNT]), STG_E_ACCESSDENIED);
    assert.equal(host.u32(COUNT), 0);
    assert.equal(call(stream2, 'SetSize', [0, 0]), STG_E_ACCESSDENIED);

    host.release(stream2);
    host.release(readOnly);
    host.putWide(NAME, PATH);
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RW, 0, 0, OUT]), S_OK);
    const writable = host.u32(OUT);
    host.putWide(NAME, 's');
    assert.equal(call(writable, 'OpenStream',
        [NAME, 0, STGM.WRITE | STGM.SHARE_EXCLUSIVE, 0, OUT2]), S_OK);
    assert.equal(call(host.u32(OUT2), 'Read', [BUFFER, 1, COUNT]), STG_E_ACCESSDENIED);
});

test('elements: names, existence and the create flag', ()=>{
    const { host, call, createDocfile, createStream, write } = setup();
    const root = createDocfile();
    const stream = createStream(root, 'Data');
    write(stream, Uint8Array.of(1, 2, 3));

    host.putWide(NAME, 'Data');
    assert.equal(call(root, 'CreateStream', [NAME, RW, 0, 0, OUT2]), STG_E_FILEALREADYEXISTS);
    assert.equal(host.u32(OUT2), 0);
    assert.equal(call(root, 'CreateStorage', [NAME, RW | STGM.CREATE, 0, 0, OUT2]),
        STG_E_FILEALREADYEXISTS, 'a stream is not replaced by a storage');
    assert.equal(call(root, 'CreateStream', [NAME, RW | STGM.CREATE, 0, 0, OUT2]), S_OK);
    assert.equal(call(host.u32(OUT2), 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(host.u32(STAT + 8), 0, 'STGM_CREATE replaced it with an empty one');

    host.putWide(NAME, 'Missing');
    assert.equal(call(root, 'OpenStream', [NAME, 0, RO, 0, OUT2]), STG_E_FILENOTFOUND);
    assert.equal(call(root, 'OpenStorage', [NAME, 0, RO, 0, 0, OUT2]), STG_E_FILENOTFOUND);
    assert.equal(call(root, 'DestroyElement', [NAME]), STG_E_FILENOTFOUND);
    host.putWide(NAME, 'Data');
    assert.equal(call(root, 'OpenStorage', [NAME, 0, RO, 0, 0, OUT2]), STG_E_FILENOTFOUND,
        'a stream is not a storage');
    assert.equal(call(root, 'OpenStream', [NAME, 0, STGM.READ | STGM_SHARE_DENY_NONE, 0, OUT2]),
        STG_E_INVALIDFLAG, 'an element is opened exclusively');

    for (const bad of ['', 'a'.repeat(32), 'a/b', 'a\\b', 'a:b', 'a!b'])
    {
        host.putWide(NAME, bad);
        assert.equal(call(root, 'CreateStream', [NAME, RW, 0, 0, OUT2]), STG_E_INVALIDNAME, bad);
    }
    assert.equal(call(root, 'CreateStream', [0, RW, 0, 0, OUT2]), STG_E_INVALIDNAME);
    host.putWide(NAME, 'a'.repeat(31));
    assert.equal(call(root, 'CreateStream', [NAME, RW, 0, 0, OUT2]), S_OK, '31 is the most');
});

test('rename, destroy, move, copy, times and state bits', ()=>{
    const { host, call, createDocfile, createStream, write } = setup();
    const root = createDocfile();
    write(createStream(root, 'one'), Uint8Array.of(1));
    write(createStream(root, 'two'), Uint8Array.of(2));
    host.putWide(NAME, 'Sub');
    assert.equal(call(root, 'CreateStorage', [NAME, RW, 0, 0, OUT2]), S_OK);
    const sub = host.u32(OUT2);

    host.putWide(NAME, 'one');
    host.putWide(NAME2, 'two');
    assert.equal(call(root, 'RenameElement', [NAME, NAME2]), STG_E_FILEALREADYEXISTS);
    host.putWide(NAME2, 'uno');
    assert.equal(call(root, 'RenameElement', [NAME, NAME2]), S_OK);
    assert.equal(call(root, 'RenameElement', [NAME, NAME2]), STG_E_FILENOTFOUND);

    host.putWide(NAME, 'two');
    host.putWide(NAME2, 'dos');
    assert.equal(call(root, 'MoveElementTo', [NAME, sub, NAME2, STGMOVE_COPY]), S_OK);
    assert.equal(call(root, 'MoveElementTo', [NAME, sub, NAME2, 0]), STG_E_FILEALREADYEXISTS);
    host.putWide(NAME2, 'moved');
    assert.equal(call(root, 'MoveElementTo', [NAME, sub, NAME2, 0]), S_OK);
    assert.equal(call(root, 'DestroyElement', [NAME]), STG_E_FILENOTFOUND, 'moved away');
    assert.equal(call(root, 'MoveElementTo', [NAME, 0x77777, NAME2, 0]), 0x80030009 | 0,
        'a destination that is not ours');
    assert.equal(host.reported.length, 1);

    // The times a program sets are the ones Stat reports.
    host.putU32(BUFFER, 0x1234);
    host.putU32(BUFFER + 4, 0x01dc);
    host.putU32(BUFFER + 8, 0x5678);
    host.putU32(BUFFER + 12, 0x01dd);
    host.putWide(NAME, 'uno');
    assert.equal(call(root, 'SetElementTimes', [NAME, BUFFER, 0, BUFFER + 8]), S_OK);
    assert.equal(call(root, 'SetElementTimes', [0, BUFFER, 0, 0]), S_OK, 'NULL is this storage');
    assert.equal(call(root, 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(host.u32(STAT + 24), 0x1234);
    assert.equal(host.u32(STAT + 28), 0x01dc);
    assert.equal(call(root, 'SetStateBits', [0xff, 0x0f]), S_OK);
    assert.equal(call(root, 'SetStateBits', [0x30, 0x30]), S_OK);
    assert.equal(call(root, 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(host.u32(STAT + 64), 0x3f);

    // CopyTo merges everything into another storage of ours.
    host.putWide(NAME, 'Other');
    assert.equal(call(root, 'CreateStorage', [NAME, RW, 0, 0, OUT2]), S_OK);
    const other = host.u32(OUT2);
    assert.equal(call(sub, 'CopyTo', [0, 0, 0, other]), S_OK);
    assert.equal(call(sub, 'CopyTo', [0, 0, 0, 0x77777]), 0x80030009 | 0);
    assert.equal(call(root, 'Commit', [0]), S_OK);
    const document = host.document();
    assert.deepEqual([...document?.children.keys() ?? []].sort(), ['OTHER', 'SUB', 'UNO']);
    assert.deepEqual([...document?.children.get('SUB')?.children.keys() ?? []].sort(),
        ['DOS', 'MOVED']);
    assert.deepEqual([...document?.children.get('OTHER')?.children.keys() ?? []].sort(),
        ['DOS', 'MOVED']);
    assert.deepEqual(document?.children.get('OTHER')?.children.get('DOS')?.data, Uint8Array.of(2));
    assert.equal(document?.children.get('UNO')?.created, 0x01dc00001234n);
    assert.equal(document?.children.get('UNO')?.modified, 0x01dd00005678n);
});

test('EnumElements walks a snapshot of the storage with names from task memory', ()=>{
    const { host, call, createDocfile, createStream, write } = setup();
    const root = createDocfile();
    write(createStream(root, 'alpha'), Uint8Array.of(1, 2));
    host.putWide(NAME, 'Beta');
    assert.equal(call(root, 'CreateStorage', [NAME, RW, 0, 0, OUT2]), S_OK);
    assert.equal(call(root, 'EnumElements', [0, 0, 0, OUT]), S_OK);
    const enumerator = host.u32(OUT);

    assert.equal(call(enumerator, 'Next', [1, STAT, COUNT]), S_OK);
    assert.equal(host.u32(COUNT), 1);
    const first = host.readWide(host.u32(STAT));
    assert.ok(host.heap.block(host.u32(STAT)));
    assert.equal(call(enumerator, 'Next', [5, STAT, COUNT]), S_FALSE, 'fewer than asked');
    assert.equal(host.u32(COUNT), 1);
    const second = host.readWide(host.u32(STAT));
    assert.deepEqual([first, second].sort(), ['Beta', 'alpha']);
    assert.equal(host.u32(STAT + 4), first === 'alpha' ? STGTY_STORAGE : STGTY_STREAM);
    assert.equal(call(enumerator, 'Next', [1, STAT, COUNT]), S_FALSE);
    assert.equal(host.u32(COUNT), 0);

    assert.equal(call(enumerator, 'Reset', []), S_OK);
    assert.equal(call(enumerator, 'Skip', [1]), S_OK);
    assert.equal(call(enumerator, 'Clone', [OUT2]), S_OK);
    assert.equal(call(host.u32(OUT2), 'Next', [1, STAT, COUNT]), S_OK, 'the clone is where it was');
    assert.equal(call(enumerator, 'Skip', [5]), S_FALSE);
    assert.equal(call(enumerator, 'Next', [2, STAT, 0]), 0x80030009 | 0,
        'more than one needs somewhere to say how many');
});

test('docfile modes: what is refused, what is reported, what is a temporary', ()=>{
    const { host, fns } = setup();
    host.putWide(NAME, PATH);
    assert.equal(fns.StgCreateDocfile.handler(
        [NAME, STGM.READWRITE | STGM_SHARE_DENY_NONE | STGM.CREATE, 0, OUT]), STG_E_INVALIDFLAG);
    assert.equal(fns.StgCreateDocfile.handler(
        [NAME, CREATE_MODE | STGM_CONVERT, 0, OUT]), STG_E_INVALIDFLAG, 'create and convert');
    assert.equal(host.u32(OUT), 0);
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RO, 0, 0, OUT]), STG_E_FILENOTFOUND);
    assert.equal(fns.StgIsStorageFile.handler([NAME]), STG_E_FILENOTFOUND);

    assert.equal(fns.StgCreateDocfile.handler([NAME, CREATE_MODE, 0, OUT]), S_OK);
    host.release(host.u32(OUT));
    assert.equal(fns.StgIsStorageFile.handler([NAME]), S_OK);
    assert.equal(fns.StgCreateDocfile.handler([NAME, RW, 0, OUT]), STG_E_FILEALREADYEXISTS,
        'STGM_FAILIFTHERE');
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RW | STGM.CREATE, 0, 0, OUT]),
        STG_E_INVALIDFLAG);
    assert.equal(fns.StgOpenStorage.handler(
        [NAME, 0, STGM.READ | STGM_SHARE_DENY_NONE, 0, 0, OUT]), STG_E_INVALIDFLAG);
    assert.equal(host.reported.length, 0);
    const transacted = STGM.READWRITE | STGM_SHARE_DENY_NONE | STGM.TRANSACTED;
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, transacted, 0, 0, OUT]), S_OK,
        'transacted with any sharing opens');
    assert.equal(host.reported.length, 1, 'and is reported as direct');
    assert.match(host.reported[0], /TRANSACTED/);
    host.release(host.u32(OUT));

    // A file that is not a docfile.
    host.files.files.set('C:\\APP\\PLAIN.TXT', new Uint8Array(600).fill(0x41));
    host.putWide(NAME, 'C:\\App\\plain.txt');
    assert.equal(fns.StgIsStorageFile.handler([NAME]), S_FALSE);
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RO, 0, 0, OUT]), STG_E_FILEALREADYEXISTS);

    // No name: a temporary that goes with the last release.
    assert.equal(fns.StgCreateDocfile.handler([0, CREATE_MODE, 0, OUT]), S_OK);
    const temporary = host.u32(OUT);
    assert.equal(host.call_(temporary, 'Stat', [STAT, 0]), S_OK);
    const name = host.readWide(host.u32(STAT));
    assert.match(name, /^C:\\WINDOWS\\TEMP\\/);
    assert.ok(host.files.stat(name)?.exists);
    host.release(temporary);
    assert.equal(host.files.stat(name), null);

    // Deletion on release when asked for by name, too.
    host.putWide(NAME, 'C:\\App\\gone.stg');
    assert.equal(fns.StgCreateDocfile.handler(
        [NAME, CREATE_MODE | STGM.DELETEONRELEASE, 0, OUT]), S_OK);
    assert.ok(host.files.stat('C:\\App\\gone.stg')?.exists);
    host.release(host.u32(OUT));
    assert.equal(host.files.stat('C:\\App\\gone.stg'), null);

    assert.equal(fns.StgCreateDocfileOnILockBytes.handler([0x1, RW, 0, OUT]),
        STG_E_INVALIDFUNCTION);
    assert.equal(fns.StgOpenStorageOnILockBytes.handler([0x1, 0, RW, 0, 0, OUT]),
        STG_E_INVALIDFUNCTION);
    assert.equal(host.u32(OUT), 0);
});

test('a memory stream lives in a global block the program can lock', ()=>{
    const { host, fns, call } = setup();
    assert.equal(fns.CreateStreamOnHGlobal.handler([0, 1, OUT]), S_OK);
    const stream = host.u32(OUT);
    assert.equal(fns.GetHGlobalFromStream.handler([stream, OUT2]), S_OK);
    const block = host.u32(OUT2);
    assert.ok(host.heap.block(block), 'a block was made for it');
    assert.equal(call(stream, 'Stat', [STAT, STATFLAG_NONAME]), S_OK);
    assert.equal(host.u32(STAT + 8), 0, 'and it starts empty');

    // Beyond the block's capacity, so it has to move.
    const data = new Uint8Array(4000).map((_, index)=>index & 0xff);
    host.bytes.set(data, BUFFER);
    assert.equal(call(stream, 'Write', [BUFFER, data.length, COUNT]), S_OK);
    assert.equal(fns.GetHGlobalFromStream.handler([stream, OUT2]), S_OK);
    const moved = host.u32(OUT2);
    assert.equal(host.heap.block(moved)?.size, 4000);
    assert.deepEqual(host.bytes.slice(moved, moved + 4000), data, 'the block holds the bytes');
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.equal(call(stream, 'Read', [BUFFER + 0x2000, 4000, COUNT]), S_OK);
    assert.deepEqual(host.bytes.slice(BUFFER + 0x2000, BUFFER + 0x2000 + 4000), data);
    host.release(stream);
    assert.equal(host.heap.block(moved), null, 'fDeleteOnRelease');

    // Over a block the program filled: the whole block is the stream.
    const own = host.heap.allocate(3);
    host.bytes.set(Uint8Array.of(7, 8, 9), own);
    assert.equal(fns.CreateStreamOnHGlobal.handler([own, 0, OUT]), S_OK);
    const over = host.u32(OUT);
    assert.equal(call(over, 'Read', [BUFFER, 10, COUNT]), S_OK);
    assert.equal(host.u32(COUNT), 3);
    assert.deepEqual(host.bytes.slice(BUFFER, BUFFER + 3), Uint8Array.of(7, 8, 9));
    host.release(over);
    assert.ok(host.heap.block(own), 'kept, as asked');

    assert.equal(fns.CreateStreamOnHGlobal.handler([0x1234, 0, OUT]), E_INVALIDARG,
        'not a block');
    assert.equal(fns.GetHGlobalFromStream.handler([0x1234, OUT2]), E_INVALIDARG);
});

test('a class travels through a stream, ours or the program\'s own', async()=>{
    const { host, fns, call, createDocfile, createStream } = setup();
    const root = createDocfile();
    const stream = createStream(root, 's');
    host.putGuid(GUID_AT, CLSID_A);
    assert.equal(fns.WriteClassStm.handler([stream, GUID_AT]), S_OK);
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    host.bytes.fill(0, GUID_AT, GUID_AT + 16);
    assert.equal(fns.ReadClassStm.handler([stream, GUID_AT]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(GUID_AT, GUID_AT + 16)), CLSID_A);
    assert.equal(fns.ReadClassStm.handler([stream, GUID_AT]), STG_E_READFAULT, 'at the end');

    assert.equal(fns.WriteClassStg.handler([root, GUID_AT]), S_OK);
    host.bytes.fill(0, GUID_AT, GUID_AT + 16);
    assert.equal(fns.ReadClassStg.handler([root, GUID_AT]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(GUID_AT, GUID_AT + 16)), CLSID_A);
    assert.equal(fns.ReadClassStg.handler([stream, GUID_AT]), E_INVALIDARG, 'not a storage');

    // A stream the program implemented: its Read and Write are called.
    /** @type {number[]} */
    const written = [];
    const guest = host.guestObject([
        ()=>0, ()=>1, ()=>0,
        ([, buffer, length, count])=>{
            host.bytes.set(parseGuid(CLSID_A) ?? [], buffer);
            host.putU32(count, Math.min(length, 16));
            return 0;
        },
        ([, buffer, length, count])=>{
            written.push(...host.bytes.subarray(buffer, buffer + length));
            host.putU32(count, length);
            return 0;
        },
    ]);
    host.putGuid(GUID_AT, CLSID_A);
    assert.equal(await fns.WriteClassStm.handler([guest, GUID_AT]), S_OK);
    assert.deepEqual(new Uint8Array(written), parseGuid(CLSID_A));
    host.bytes.fill(0, GUID_AT, GUID_AT + 16);
    assert.equal(await fns.ReadClassStm.handler([guest, GUID_AT]), S_OK);
    assert.equal(formatGuid(host.bytes.subarray(GUID_AT, GUID_AT + 16)), CLSID_A);
    assert.equal(host.heap.live.size, 0, 'the buffers lent to the guest were taken back');
});

test('OleSaveToStream asks the object for its class and then lets it save', async()=>{
    const { host, fns, call, createDocfile, createStream, read } = setup();
    const root = createDocfile();
    const stream = createStream(root, 'object');
    const persist = host.guestObject([
        ()=>0, ()=>1, ()=>0,
        // GetClassID
        ([, out])=>{
            host.putGuid(out, CLSID_A);
            return 0;
        },
        ()=>S_FALSE,
        ()=>0,
        // Save(pStm, fClearDirty): writes its data through the stream.
        ([, pStm, clear])=>{
            assert.equal(pStm, stream);
            assert.equal(clear, 1);
            host.bytes.set(Uint8Array.of(0xaa, 0xbb), BUFFER + 0x800);
            return call(stream, 'Write', [BUFFER + 0x800, 2, 0]);
        },
        ()=>0,
    ]);
    assert.equal(await fns.OleSaveToStream.handler([persist, stream]), S_OK);
    assert.equal(host.guestCalls.length, 2);
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    const saved = read(stream, 100);
    assert.equal(saved.length, 18);
    assert.equal(formatGuid(saved.subarray(0, 16)), CLSID_A);
    assert.deepEqual(saved.subarray(16), Uint8Array.of(0xaa, 0xbb));

    // Loading it back: the class is the program's, and nothing here makes it.
    assert.equal(call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    host.putGuid(GUID_AT, '{00000109-0000-0000-C000-000000000046}');
    assert.equal(await fns.OleLoadFromStream.handler([stream, GUID_AT, OUT]), REGDB_E_CLASSNOTREG);
    assert.equal(host.u32(OUT), 0);
    assert.ok(host.reported.some(text=>text.includes(CLSID_A)));
    assert.equal(await fns.OleLoadFromStream.handler([stream, GUID_AT, OUT]), STG_E_READFAULT,
        'nothing left to read a class from');
});

test('an interface crosses threads through a stream, with the references it takes', async()=>{
    const { host, fns } = setup();
    const marshal = fns.CoMarshalInterThreadInterfaceInStream;
    let references = 1;
    const guest = host.guestObject([
        ([, , ppv])=>{
            host.putU32(ppv, 0x5555);
            references++;
            return 0;
        },
        ()=>++references,
        ()=>--references,
    ]);
    host.putGuid(GUID_AT, '{00000000-0000-0000-C000-000000000046}');
    assert.equal(await marshal.handler([GUID_AT, guest, OUT]), S_OK);
    const stream = host.u32(OUT);
    assert.notEqual(stream, 0);
    assert.equal(references, 2, 'marshaling holds a reference');

    assert.equal(await fns.CoGetInterfaceAndReleaseStream.handler([stream, GUID_AT, OUT2]), S_OK);
    assert.equal(host.u32(OUT2), 0x5555, 'what the object answered to QueryInterface');
    assert.equal(references, 2, 'the QueryInterface reference stays and the marshaled one goes');
    assert.equal(host.objectAt(stream), undefined, 'and the stream is gone');
    assert.equal(host.heap.live.size, 0, 'with the block it held');

    assert.equal(marshal.handler([GUID_AT, 0, OUT]), E_INVALIDARG);
    assert.equal(await fns.CoGetInterfaceAndReleaseStream.handler([0x7777, GUID_AT, OUT2]),
        E_INVALIDARG, 'not a stream of ours');
});

test('the objects publish the documented tables, and identity holds through them', ()=>{
    const { host, call, createDocfile, createStream } = setup();
    const root = createDocfile();
    assert.deepEqual(host.methodNames(root), [
        ['QueryInterface', 12], ['AddRef', 4], ['Release', 4],
        ['CreateStream', 24], ['OpenStream', 24], ['CreateStorage', 24], ['OpenStorage', 28],
        ['CopyTo', 20], ['MoveElementTo', 20], ['Commit', 8], ['Revert', 4],
        ['EnumElements', 20], ['DestroyElement', 8], ['RenameElement', 12],
        ['SetElementTimes', 20], ['SetClass', 8], ['SetStateBits', 12], ['Stat', 12],
    ]);
    const stream = createStream(root, 's');
    assert.deepEqual(host.methodNames(stream), [
        ['QueryInterface', 12], ['AddRef', 4], ['Release', 4],
        ['Read', 16], ['Write', 16], ['Seek', 20], ['SetSize', 12], ['CopyTo', 24],
        ['Commit', 8], ['Revert', 4], ['LockRegion', 24], ['UnlockRegion', 24], ['Stat', 12],
        ['Clone', 8],
    ]);
    assert.equal(call(root, 'EnumElements', [0, 0, 0, OUT]), S_OK);
    assert.deepEqual(host.methodNames(host.u32(OUT)), [
        ['QueryInterface', 12], ['AddRef', 4], ['Release', 4],
        ['Next', 16], ['Skip', 8], ['Reset', 4], ['Clone', 8],
    ]);
    const record = host.registry.create('{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0011}');
    assert.equal(record, null, 'the private classes make nothing on their own');

    // ISequentialStream is the front of IStream, from the same object, and
    // the same interface publishes to the same pointer.
    const sequential = host.vtables.publish(host.objectAt(stream), IID_ISEQUENTIALSTREAM);
    assert.notEqual(sequential, 0);
    assert.equal(host.methodNames(sequential).length, 5);
    assert.equal(host.vtables.publish(host.objectAt(stream), IID_ISTREAM), stream);
    assert.equal(host.vtables.publish(host.objectAt(root), IID_ISTORAGE), root);
    assert.equal(host.vtables.publish(host.objectAt(root), IID_IENUMSTATSTG), 0);
});

test('a stream copies into another stream, ours or the program\'s', async()=>{
    const { host, call, createDocfile, createStream, write, read } = setup();
    const root = createDocfile();
    const source = createStream(root, 'from');
    write(source, Uint8Array.of(1, 2, 3, 4, 5, 6));
    const target = createStream(root, 'to');
    assert.equal(call(source, 'Seek', [1, 0, 0, 0]), S_OK);
    assert.equal(call(source, 'CopyTo', [target, 3, 0, COUNT, COUNT2]), S_OK);
    assert.equal(host.u32(COUNT), 3);
    assert.equal(host.u32(COUNT2), 3);
    assert.equal(call(source, 'CopyTo', [target, 0xffffffff, 0xffffffff, COUNT, COUNT2]), S_OK,
        'everything that is left');
    assert.equal(host.u32(COUNT), 2);
    assert.equal(call(target, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.deepEqual(read(target, 10), Uint8Array.of(2, 3, 4, 5, 6));

    /** @type {number[]} */
    const written = [];
    const guest = host.guestObject([
        ()=>0, ()=>1, ()=>0, ()=>0,
        ([, buffer, length, count])=>{
            written.push(...host.bytes.subarray(buffer, buffer + length));
            host.putU32(count, length);
            return 0;
        },
    ]);
    assert.equal(call(source, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.equal(await call(source, 'CopyTo', [guest, 4, 0, COUNT, COUNT2]), S_OK);
    assert.deepEqual(written, [1, 2, 3, 4]);
    assert.equal(host.u32(COUNT2), 4);
});

test('a docfile written by hand is what the objects read', ()=>{
    const { host, fns, call, read } = setup();
    const root = createRoot();
    const entry = { ...createRoot(), name: 'payload', kind: /** @type {'stream'} */ ('stream') };
    entry.data = Uint8Array.of(9, 8, 7);
    root.children.set('PAYLOAD', entry);
    host.files.files.set(PATH.toUpperCase(), serializeCompoundFile(root));
    host.putWide(NAME, PATH);
    assert.equal(fns.StgOpenStorage.handler([NAME, 0, RO, 0, 0, OUT]), S_OK);
    host.putWide(NAME, 'payload');
    assert.equal(call(host.u32(OUT), 'OpenStream', [NAME, 0, RO, 0, OUT2]), S_OK);
    assert.deepEqual(read(host.u32(OUT2), 10), Uint8Array.of(9, 8, 7));
});
