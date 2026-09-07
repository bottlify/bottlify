/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVersionFunctions } from './functions.js';

/**
 * Builds a VS_VERSIONINFO block by hand.
 *
 * Every node is a length, a value length, a type, a UTF-16 key, then the value
 * and the children, each padded up to the next dword. The padding is what a
 * reader gets wrong, so the builder puts it in rather than assuming it away.
 */
/**
 * @param {string} key
 * @param {{ value?: Uint8Array, text?: string | null, children?: Uint8Array[] }} [parts]
 */
function node(key, parts = {}){
    const { value = new Uint8Array(0), text = null, children = [] } = parts;
    const keyBytes = [...key]
        .flatMap(character=>[character.charCodeAt(0) & 0xff, character.charCodeAt(0) >> 8])
        .concat([0, 0]);

    const body = text === null
        ? [...value]
        : [...text].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])
            .concat([0, 0]);
    const valueLength = text === null ? body.length : body.length / 2;

    const beforeValue = 6 + keyBytes.length;
    const pad = (beforeValue + 3 & ~3) - beforeValue;
    const afterValue = beforeValue + pad + body.length;
    const childPad = (afterValue + 3 & ~3) - afterValue;

    const kids = children.flatMap(child=>[...child]);
    const length = afterValue + childPad + kids.length;

    return new Uint8Array([
        length & 0xff, length >> 8 & 0xff,
        valueLength & 0xff, valueLength >> 8 & 0xff,
        text === null ? 0 : 1, 0,
        ...keyBytes,
        ...new Array(pad).fill(0),
        ...body,
        ...new Array(childPad).fill(0),
        ...kids,
    ]);
}

/**
 * VS_FIXEDFILEINFO, with trailing bytes the node counts and the query must not.
 *
 * Real blocks do carry a value longer than the structure, and a query that
 * reported the node's own length would hand the caller more than it can copy.
 */
function fixedInfo(){
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xfeef04bd, true);
    view.setUint32(8, 1 << 16 | 26, true); // dwFileVersionMS
    view.setUint32(12, 0, true);
    return bytes;
}

function block(){
    return node('VS_VERSION_INFO', {
        value: fixedInfo(),
        children: [
            node('StringFileInfo', {
                children: [node('040904b0', {
                    children: [
                        node('ProductName', { text: 'A Program' }),
                        node('FileVersion', {
                            text: '1.26',
                            // Unusual but legal, and the only shape in which
                            // "characters, not bytes" decides where to look.
                            children: [node('Nested', { text: 'here' })],
                        }),
                    ],
                })],
            }),
            node('VarFileInfo', {
                children: [node('Translation', {
                    value: new Uint8Array([0x09, 0x04, 0xb0, 0x04]),
                })],
            }),
        ],
    });
}

/** @param {Uint8Array | null} resource */
function machine(resource = block()){
    const memory = new Uint8Array(0x2000);
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>
            memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
        readCString: (/** @type {number} */ a)=>{
            let text = '';
            for (let at = a; memory[at] !== 0 && at < memory.length; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        setLastError: ()=>{},
        versionInfo: ()=>resource,
    };
    /** @param {number} at @param {string} text */
    const putString = (at, text)=>{
        memory.set(new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat([0])), at);
    };
    const get32 = (/** @type {number} */ at)=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;
    return { memory, host, putString, get32,
        version: /** @type {any} */ (createVersionFunctions(host)) };
}

test('the size reported is the resource, and zero when there is none', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    assert.equal(m.version.GetFileVersionInfoSizeA.handler([0x10, 0x20]), block().length);
    assert.equal(m.get32(0x20), 0, 'the handle is documented as zero, and written');

    const empty = machine(null);
    empty.putString(0x10, 'C:\\thing.exe');
    assert.equal(empty.version.GetFileVersionInfoSizeA.handler([0x10, 0]), 0,
        'a file with no version information is ordinary, not an error');
});

test('the block is copied whole, and a short buffer is refused', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    const size = block().length;

    assert.equal(m.version.GetFileVersionInfoA.handler([0x10, 0, size - 1, 0x400]), 0);
    assert.equal(m.version.GetFileVersionInfoA.handler([0x10, 0, size, 0x400]), 1);
    assert.deepEqual(m.memory.slice(0x400, 0x400 + size), block());
});

test('the root query answers with the fixed information, at its own size', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 52, 'always the structure size, not the node value');
    // The pointer is into the caller's own block, not a copy.
    const at = m.get32(0x30);
    assert.ok(at > 0x400 && at < 0x400 + block().length);
    assert.equal(m.get32(at), 0xfeef04bd, 'and it lands on the signature');
    assert.equal(m.get32(at + 8), 1 << 16 | 26);
});

test('a string is found down the tree, and its length is in characters', ()=>{
    // wValueLength counts bytes for a binary value and characters for a text
    // one. A reader that treats them alike halves or doubles every string.
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\FileVersion');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 5, '"1.26" and its terminator, in characters');

    const at = m.get32(0x30);
    let text = '';
    for (let step = 0; step < 4; step++)
    {
        text += String.fromCharCode(m.memory[at + step * 2]);
    }
    assert.equal(text, '1.26');
});

test('the translation is a binary value, counted in bytes', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\VarFileInfo\\Translation');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 4, 'four bytes, not four characters');
});

test('a child of a text node is found past its characters, not its bytes', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\FileVersion\\Nested');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 5, '"here" and its terminator');
});

test('a query for something that is not there fails rather than guessing', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\CompanyName');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 0);
});
