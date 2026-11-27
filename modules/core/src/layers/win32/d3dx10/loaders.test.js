/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The data loaders as Wine's d3dx11 tests say D3DX answers
 * (test_D3DX11CreateAsyncMemoryLoader, ...FileLoader, ...ResourceLoader).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataLoaders } from './loaders.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const NOT_FOUND = 0x887c0002 | 0;
const INVALID_DATA = 0x88760b59 | 0;

function machine(){
    const bytes = new Uint8Array(1 << 18);
    const view = new DataView(bytes.buffer);
    // Above 0xffff: a lower address is a resource's number, not its name.
    let next = 0x10000;
    /** @type {Map<number, any>} */
    const pointers = new Map();
    /** @type {Set<number>} */
    const freed = new Set();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    const fns = createDataLoaders({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        heap: { allocate: size=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        }, free: at=>freed.add(at) },
        vtables: { publish: (object, id)=>{
            const at = next;
            next += 16;
            pointers.set(at, object.interfaceFor(id));
            return at;
        }, unpublish: ()=>true },
        readFile: path=>files.get(path) ?? null,
        resource: (module, name)=>(name === 'present' ? Uint8Array.of(1, 2, 3) : null),
    }, { prefix: 'D3DX11', fileNotFound: NOT_FOUND,
        string: (at, wide)=>{
            let text = '';
            for (let i = at; wide ? view.getUint16(i, true) : bytes[i]; i += wide ? 2 : 1)
            {
                text += String.fromCharCode(wide ? view.getUint16(i, true) : bytes[i]);
            }
            return text;
        } });
    const out = ()=>{
        const at = next;
        next += 16;
        return at;
    };
    /** @param {string} text */
    const ansi = text=>{
        const at = out() + 0x40;
        next += 0x40;
        bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        return at;
    };
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    /** @param {number} loader @param {string} name @param {...number} args */
    const call = (loader, name, ...args)=>pointers.get(loader).methods
        .find((/** @type {any} */ m)=>m.name === name).invoke(null, args);
    return { fns, out, ansi, u32, call, files, bytes, freed };
}

test('a memory loader hands the program\'s own bytes back; Load does nothing', ()=>{
    const m = machine();
    const out = m.out();
    assert.equal(m.fns.D3DX11CreateAsyncMemoryLoader.handler([0, 0, 0]), E_FAIL);
    assert.equal(m.fns.D3DX11CreateAsyncMemoryLoader.handler([0, 0, out]), E_FAIL);
    assert.equal(m.fns.D3DX11CreateAsyncMemoryLoader.handler([0x500, 4, out]), S_OK);
    const loader = m.u32(out);
    const where = m.out();
    const size = m.out();
    assert.equal(m.call(loader, 'Load'), S_OK);
    assert.equal(m.call(loader, 'Decompress', where, size), S_OK);
    assert.deepEqual([m.u32(where), m.u32(size)], [0x500, 4]);
    assert.equal(m.call(loader, 'Destroy'), S_OK);
});

test('a file loader reads at each Load, keeps the last bytes when the file goes, and has'
    + ' nothing before a load', async()=>{
    const m = machine();
    const out = m.out();
    assert.equal(m.fns.D3DX11CreateAsyncFileLoaderA.handler([0, out]), E_FAIL);
    assert.equal(m.fns.D3DX11CreateAsyncFileLoaderA.handler([m.ansi('data'), out]), S_OK,
        'the file is not looked for yet');
    const loader = m.u32(out);
    const where = m.out();
    const size = m.out();
    assert.equal(m.call(loader, 'Decompress', where, size), E_FAIL);
    assert.equal(await m.call(loader, 'Load'), NOT_FOUND);
    m.files.set('data', Uint8Array.of(9, 8, 7));
    assert.equal(await m.call(loader, 'Load'), S_OK);
    m.files.delete('data');
    assert.equal(await m.call(loader, 'Load'), NOT_FOUND);
    assert.equal(m.call(loader, 'Decompress', where, size), S_OK, 'what was read stays');
    assert.equal(m.u32(size), 3);
    assert.deepEqual([...m.bytes.subarray(m.u32(where), m.u32(where) + 3)], [9, 8, 7]);
    const first = m.u32(where);
    m.files.set('data', Uint8Array.of(1, 2, 3, 4));
    assert.equal(await m.call(loader, 'Load'), S_OK);
    m.call(loader, 'Decompress', where, size);
    assert.equal(m.u32(size), 4, 'a later load replaces it');
    assert.ok(m.freed.has(first), 'and frees what it replaced');
    assert.equal(m.call(loader, 'Destroy'), S_OK);
    assert.ok(m.freed.has(m.u32(where)), 'and the loader frees it when destroyed');
});

test('a resource loader is refused for a resource the module does not have', async()=>{
    const m = machine();
    const out = m.out();
    assert.equal(await m.fns.D3DX11CreateAsyncResourceLoaderA.handler([0, 0, 0]), E_FAIL);
    assert.equal(await m.fns.D3DX11CreateAsyncResourceLoaderA.handler([0, 0, out]),
        INVALID_DATA);
    assert.equal(await m.fns.D3DX11CreateAsyncResourceLoaderA.handler([0, m.ansi('noname'),
        out]), INVALID_DATA);
    assert.equal(await m.fns.D3DX11CreateAsyncResourceLoaderA.handler([0, m.ansi('present'),
        out]), S_OK);
});
