/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDbghelpFunctions } from './functions.js';

/**
 * A guest memory of one page at 0x1000 and a module at 0x400000.
 */
function machine(){
    const memory = new Uint8Array(0x2000);
    let lastError = 0;
    const fns = createDbghelpFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            if (address < 0x1000 || address + length > 0x3000)
            {
                throw new RangeError('unmapped');
            }
            return memory.slice(address - 0x1000, address - 0x1000 + length);
        },
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>{ memory.set(bytes, address - 0x1000); },
        modules: ()=>[{ base: 0x400000, size: 0x10000 }],
        /** @param {number} code */
        setLastError: code=>{ lastError = code; },
    });
    const view = new DataView(memory.buffer);
    return {
        fns,
        /** @param {number} address @param {number} value */
        put: (address, value)=>view.setUint32(address - 0x1000, value, true),
        /** @param {number} address */
        get: address=>view.getUint32(address - 0x1000, true),
        lastError: ()=>lastError,
    };
}

test('the options are what was last set, undecorated names before that', ()=>{
    const { fns } = machine();
    assert.equal(fns.SymGetOptions.handler([]), 0x2);
    assert.equal(fns.SymSetOptions.handler([0x216]), 0x216);
    assert.equal(fns.SymGetOptions.handler([]), 0x216);
    assert.equal(fns.SymInitialize.handler([-1, 0, 1]), 1);
    assert.equal(fns.SymCleanup.handler([-1]), 1);
});

test('a module is known by where it is mapped; a symbol or a line is not found', ()=>{
    const { fns, lastError } = machine();
    assert.equal(fns.SymLoadModule.handler([-1, 0, 0, 0, 0x400000, 0]), 0x400000);
    assert.equal(fns.SymGetModuleBase.handler([-1, 0x401234]), 0x400000);
    assert.equal(fns.SymGetModuleBase.handler([-1, 0x500000]), 0);
    assert.equal(lastError(), 126);
    assert.equal(fns.SymFunctionTableAccess.handler([-1, 0x400000]), 0);
    assert.equal(fns.SymGetSymFromAddr.handler([-1, 0x401234, 0x1800, 0x1900]), 0);
    assert.equal(lastError(), 487);
    assert.equal(fns.SymGetLineFromAddr.handler([-1, 0x401234, 0x1800, 0x1900]), 0);
});

test('StackWalk reports the given frame, then steps along the EBP chain to its end', ()=>{
    const { fns, put, get } = machine();
    // Two frames: 0x2000 -> 0x2100 -> 0 (the outermost).
    put(0x2000, 0x2100);
    put(0x2004, 0x401111);
    put(0x2008, 7);
    put(0x2100, 0);
    put(0x2104, 0x402222);
    const frame = 0x1100;
    put(frame + 0, 0x400500);
    put(frame + 24, 0x2000);
    put(frame + 36, 0x1ff0);
    const walk = ()=>fns.StackWalk.handler([0x14c, -1, -2, frame, 0x1300, 0, 0, 0, 0]);
    assert.equal(fns.StackWalk.argBytes, 36);

    assert.equal(walk(), 1);
    assert.deepEqual([get(frame), get(frame + 12), get(frame + 24), get(frame + 36)],
        [0x400500, 0x401111, 0x2000, 0x1ff0]);
    assert.equal(get(frame + 8), 3, 'AddrModeFlat');
    assert.equal(get(frame + 52), 7, 'the first parameter');

    assert.equal(walk(), 1);
    assert.deepEqual([get(frame), get(frame + 12), get(frame + 24), get(frame + 36)],
        [0x401111, 0x402222, 0x2100, 0x2008]);

    assert.equal(walk(), 0, 'a zero frame ends the walk');
});

test('StackWalk ends where the chain leaves mapped memory, and refuses another machine', ()=>{
    const { fns, put, lastError } = machine();
    const frame = 0x1100;
    put(frame + 0, 0x400500);
    put(frame + 24, 0x9000);
    assert.equal(fns.StackWalk.handler([0x14c, -1, -2, frame, 0, 0, 0, 0, 0]), 0);
    assert.equal(fns.StackWalk.handler([0x8664, -1, -2, frame, 0, 0, 0, 0, 0]), 0);
    assert.equal(lastError(), 87);
});

test('MakeSureDirectoryPathExists makes every missing directory up to the last backslash', ()=>{
    /** @type {Set<string>} */
    const directories = new Set(['C:', 'C:\\Game']);
    const files = new Set(['C:\\Game\\file.txt']);
    /** @type {Map<number, string>} */
    const strings = new Map([[0x10, 'C:\\Game\\Profiles\\Player\\'],
        [0x20, 'C:\\Game\\Logs\\run.log'], [0x30, 'C:\\Game\\file.txt\\sub\\'],
        [0x40, 'C:\\Game\\Profiles\\']]);
    let lastError = 0;
    const { MakeSureDirectoryPathExists: make } = createDbghelpFunctions({
        readMemory: ()=>new Uint8Array(0),
        writeMemory: ()=>{},
        modules: ()=>[],
        setLastError: code=>{ lastError = code; },
        readCString: address=>strings.get(address) ?? '',
        files: {
            stat: path=>(directories.has(path) ? { exists: true, isDirectory: true }
                : files.has(path) ? { exists: true, isDirectory: false } : null),
            mkdir: path=>{
                if (!directories.has(path.slice(0, path.lastIndexOf('\\'))))
                {
                    return false;
                }
                directories.add(path);
                return true;
            },
        },
    });
    assert.equal(make.handler([0x10]), 1);
    assert.ok(directories.has('C:\\Game\\Profiles'));
    assert.ok(directories.has('C:\\Game\\Profiles\\Player'));
    assert.equal(make.handler([0x20]), 1, 'the last part is a file\'s name');
    assert.ok(directories.has('C:\\Game\\Logs'));
    assert.equal(directories.has('C:\\Game\\Logs\\run.log'), false);
    assert.equal(make.handler([0x40]), 1, 'already there');
    assert.equal(make.handler([0x30]), 0, 'a file where a directory is wanted');
    assert.equal(lastError, 183);
    assert.equal(make.handler([0]), 0);
});
