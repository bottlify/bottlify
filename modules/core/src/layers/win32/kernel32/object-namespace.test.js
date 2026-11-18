/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The object namespace's walk and the directory and link calls over it, by
 * the answers Wine's ntdll om tests have Windows give.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNamedObjects } from './named-objects.js';
import { createDirectoryNatives } from './object-directories.js';

const STATUS_SUCCESS = 0;
const STATUS_OBJECT_NAME_EXISTS = 0x40000000;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_OBJECT_TYPE_MISMATCH = 0xc0000024;
const STATUS_OBJECT_NAME_INVALID = 0xc0000033;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
const STATUS_OBJECT_PATH_SYNTAX_BAD = 0xc000003b;
const OBJ_CASE_INSENSITIVE = 0x40;
const OBJ_OPENIF = 0x80;

/** A process: its memory, its handles, its view of a run's table. */
function machine(table = new Map()){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { kind: string, object: any }>} */
    const entries = new Map();
    let next = 0x100;
    const handles = {
        open: (/** @type {string} */ kind, /** @type {any} */ object)=>{
            next += 4;
            entries.set(next, { kind, object });
            return next;
        },
        typeOf: (/** @type {number} */ handle)=>entries.get(handle)?.kind ?? null,
        resolve: (/** @type {number} */ handle)=>entries.get(handle)?.object,
    };
    const named = createNamedObjects({ table, handles });
    const natives = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        createDirectoryNatives({
            readMemory: (address, length)=>bytes.slice(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
            kernel: { handles }, namedObjects: named,
        }));
    const OUT = 0x10;
    /**
     * An OBJECT_ATTRIBUTES at 0x100, its name at 0x200 (none for null).
     *
     * @param {string | null} name @param {number} [root] @param {number} [flags]
     */
    const attributes = (name, root = 0, flags = 0)=>{
        bytes.fill(0, 0x100, 0x400);
        view.setUint32(0x100, 24, true);
        view.setUint32(0x104, root, true);
        view.setUint32(0x10c, flags, true);
        if (name !== null)
        {
            view.setUint16(0x200, name.length * 2, true);
            view.setUint16(0x202, name.length * 2 + 2, true);
            view.setUint32(0x204, 0x210, true);
            [...name].forEach((ch, at)=>view.setUint16(0x210 + at * 2, ch.charCodeAt(0), true));
            view.setUint32(0x108, 0x200, true);
        }
        return 0x100;
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>natives[name].handler(args) >>> 0;
    return {
        named, entries, view, bytes, OUT,
        out: ()=>view.getUint32(OUT, true),
        /** @param {string | null} name @param {number} [root] @param {number} [flags] */
        dir: (name, root, flags)=>call('NtCreateDirectoryObject', OUT, 0xf000f,
            attributes(name, root, flags)),
        /** @param {string | null} name @param {number} [root] @param {number} [flags] */
        openDir: (name, root, flags)=>call('NtOpenDirectoryObject', OUT, 1,
            attributes(name, root, flags)),
        /** @param {string} name @param {string} target @param {number} [root] */
        link: (name, target, root)=>{
            const at = attributes(name, root);
            view.setUint16(0x300, target.length * 2, true);
            view.setUint16(0x302, target.length * 2 + 2, true);
            view.setUint32(0x304, 0x310, true);
            [...target].forEach((ch, i)=>view.setUint16(0x310 + i * 2, ch.charCodeAt(0), true));
            return call('NtCreateSymbolicLinkObject', OUT, 1, at, 0x300);
        },
        /** @param {string} name @param {number} [root] */
        openLink: (name, root)=>call('NtOpenSymbolicLinkObject', OUT, 1,
            attributes(name, root)),
        /** @param {number} handle @param {number} room */
        queryLink: (handle, room)=>{
            view.setUint16(0x300, 0x4444, true);
            view.setUint16(0x302, room, true);
            view.setUint32(0x304, 0x310, true);
            view.setUint32(0x20, 0xdeadbeef, true);
            const status = call('NtQuerySymbolicLinkObject', handle, 0x300, 0x20);
            return { status, length: view.getUint16(0x300, true),
                returned: view.getUint32(0x20, true) };
        },
        /**
         * Where a native name is kept for an event, or its status.
         *
         * @param {string} name @param {number} [root] @param {number} [flags]
         */
        key: (name, root = 0, flags = 0)=>named.keyOf({ root, name, attributes: flags, invalid: 0,
            security: 0 }, 'event'),
    };
}

test('a Win32 name is kept under itself, through either BaseNamedObjects and their links', ()=>{
    const m = machine();
    assert.equal(m.key('\\BaseNamedObjects\\x'), 'x');
    assert.equal(m.key('\\Sessions\\1\\BaseNamedObjects\\x'), 'x');
    assert.equal(m.key('\\BaseNamedObjects\\Local\\x'), 'x');
    assert.equal(m.key('\\BaseNamedObjects\\Session\\1\\x'), 'x', 'through BNOLINKS');
    assert.equal(m.key('\\??\\GLOBALROOT\\BaseNamedObjects\\x'), 'x',
        'GLOBALROOT\'s empty target is the root');
    assert.equal(m.key('\\BASENamedObjects\\x'), STATUS_OBJECT_PATH_NOT_FOUND,
        'a directory is found as it is spelt');
    assert.equal(m.key('\\BASENamedObjects\\x', 0, OBJ_CASE_INSENSITIVE), 'x');
    assert.equal(m.key('\\BasedNamedObjects\\Local\\x'), STATUS_OBJECT_PATH_NOT_FOUND);
});

test('a malformed path is refused by the part that is wrong', ()=>{
    const m = machine();
    assert.equal(m.key('BaseNamedObjects'), STATUS_OBJECT_PATH_SYNTAX_BAD);
    assert.equal(m.key('\\BaseNamedObjects\\'), STATUS_OBJECT_NAME_INVALID);
    assert.equal(m.key('\\\\BaseNamedObjects'), STATUS_OBJECT_NAME_INVALID);
    assert.equal(m.key('\\BaseNamedObjects\\\\x'), STATUS_OBJECT_NAME_INVALID);
    assert.equal(m.key('\\BaseNamedObjects\\nowhere\\'), STATUS_OBJECT_PATH_NOT_FOUND,
        'the walk fails before the empty name is seen');
});

test('in any case, the most recently made of the names that differ only in case', ()=>{
    const table = new Map();
    const m = machine(table);
    m.named.remember('test', 'mutex', { id: 1 }, false, ()=>{});
    m.named.remember('Test', 'event', { id: 2 }, false, ()=>{});
    assert.equal(m.key('\\BaseNamedObjects\\TEst'), 'TEst', 'spelt so, a free name');
    assert.equal(m.key('\\BaseNamedObjects\\TEst', 0, OBJ_CASE_INSENSITIVE), 'Test');
});

test('directories: made and opened by path or relative to a handle, the root a collision', ()=>{
    const m = machine();
    assert.equal(m.dir('\\'), STATUS_OBJECT_NAME_COLLISION);
    assert.equal(m.dir('\\', 0, OBJ_OPENIF), STATUS_OBJECT_NAME_EXISTS);
    assert.equal(m.dir(null), STATUS_SUCCESS, 'a directory with no name');
    assert.equal(m.openDir(null), STATUS_OBJECT_PATH_SYNTAX_BAD);
    assert.equal(m.dir('\\BaseNamedObjects\\om.c-test'), STATUS_SUCCESS);
    const made = m.out();
    assert.equal(m.dir('\\BaseNamedObjects\\om.c-test\\one more level'), STATUS_SUCCESS);
    assert.equal(m.dir('one more level', made), STATUS_OBJECT_NAME_COLLISION,
        'the same directory, reached through the handle');
    assert.equal(m.openDir('\\BaseNamedObjects'), STATUS_SUCCESS);
    const base = m.out();
    assert.equal(m.openDir('', base), STATUS_SUCCESS, 'an empty name is the directory itself');
    assert.equal(m.openDir(null, base), STATUS_OBJECT_NAME_INVALID);
    assert.equal(m.openDir('\\x', base), STATUS_OBJECT_PATH_SYNTAX_BAD);
    assert.equal(m.openDir('om.c-test\\', base), STATUS_OBJECT_NAME_INVALID);
    assert.equal(m.openDir('nowhere\\', base), STATUS_OBJECT_PATH_NOT_FOUND);
    assert.equal(m.openDir('\\BaseNamedObjects\\nothing'), STATUS_OBJECT_NAME_NOT_FOUND);
    // An event made in the directory is kept under its whole path.
    assert.equal(m.key('x', made), '\\BaseNamedObjects\\om.c-test\\x');
});

test('links: a link is followed on the way, opened as itself last, and read back', ()=>{
    const m = machine();
    assert.equal(m.openLink('\\BaseNamedObjects\\Local'), STATUS_SUCCESS);
    const local = m.out();
    assert.equal(m.dir('one more level', local), STATUS_OBJECT_TYPE_MISMATCH,
        'a link is no directory to make in');
    assert.equal(m.openDir('\\BaseNamedObjects\\Local'), STATUS_SUCCESS,
        'a link last is followed for another kind');
    assert.equal(m.link('\\', 'anywhere'), STATUS_OBJECT_TYPE_MISMATCH);
    assert.equal(m.link('\\BaseNamedObjects\\to-device', '\\Device'), STATUS_SUCCESS);
    assert.equal(m.key('\\BaseNamedObjects\\to-device\\x'), '\\Device\\x');

    const target = '\\Sessions\\1\\BaseNamedObjects';
    const whole = target.length * 2 + 2;
    let read = m.queryLink(local, 256);
    assert.deepEqual([read.status, read.length, read.returned],
        [STATUS_SUCCESS, whole - 2, whole]);
    assert.equal(String.fromCharCode(...new Uint16Array(m.bytes.slice(0x310, 0x310 + whole - 2)
        .buffer)), target);
    read = m.queryLink(local, whole - 2);
    assert.deepEqual([read.status, read.length, read.returned],
        [STATUS_BUFFER_TOO_SMALL, 0x4444, whole], 'no room for the terminator');
});

test('a directory made by one process is found by another over the run\'s table', ()=>{
    const table = new Map();
    const first = machine(table);
    const second = machine(table);
    assert.equal(first.dir('\\BaseNamedObjects\\shared-dir'), STATUS_SUCCESS);
    assert.equal(second.openDir('\\BaseNamedObjects\\shared-dir'), STATUS_SUCCESS);
});
