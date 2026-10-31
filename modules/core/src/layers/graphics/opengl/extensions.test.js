/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The extension promise: every name in the extension string has all of its
 * entry points, every entry point has a stack size, and nothing reported is
 * unimplemented. A program that reads the string and then finds a null
 * pointer crashes on the first call, which is why this is a test and not a
 * convention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EXTENSION_FUNCTIONS, EXTENSION_WORDS, GL_EXTENSIONS, GL_VERSIONS, HIDDEN_GL_EXTENSIONS,
    WGL_EXTENSIONS,
} from './extensions.js';
import { ARGUMENT_WORDS, createOpengl } from './exports.js';
import { CORE_FUNCTIONS } from './context.js';
import { ALL_QUERIES, CLIENT_BITS, NOT_SAVED, SERVER_BITS } from './attributes.js';
import { GL } from './constants.js';

/** A library over a 4x4 screen with a way to hand out addresses. */
function library(withAddresses = true){
    const bytes = new Uint8Array(0x10000);
    let next = 0x100;
    /** @type {string[]} */
    const asked = [];
    const opengl = createOpengl({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, value)=>bytes.set(value, at),
        screen: ()=>({ width: 4, height: 4 }),
        scratch: { allocate: size=>{
            const at = next;
            next += (size + 16) & ~15;
            return at;
        } },
        exportAddress: withAddresses
            ? name=>{
                asked.push(name);
                return 0x7000_0000 + [...name].reduce((sum, c)=>sum + c.charCodeAt(0), 0);
            }
            : undefined,
    });
    const hdc = 0x900d;
    // With no device behind it no call waits, so every handler answers a number.
    const table = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (opengl.table);
    assert.equal(table.wglSetPixelFormat.handler([hdc, 1, 0]), 1);
    const context = table.wglCreateContext.handler([hdc]);
    assert.equal(table.wglMakeCurrent.handler([hdc, context]), 1);
    /** @param {string} text @returns {number} */
    const cstring = text=>{
        const at = next;
        const encoded = new TextEncoder().encode(`${text}\0`);
        bytes.set(encoded, at);
        next += (encoded.length + 16) & ~15;
        return at;
    };
    /** @param {number} at @returns {string} */
    const readString = at=>new TextDecoder().decode(bytes.subarray(at, bytes.indexOf(0, at)));
    return { opengl, table, bytes, hdc, cstring, readString, asked };
}

test('every extension function is declared, sized and implemented', ()=>{
    const declared = new Set(Object.values(EXTENSION_WORDS).flat());
    const { opengl } = library();
    const implemented = new Set(opengl.implemented);
    for (const [extension, functions] of Object.entries({ ...GL_EXTENSIONS, ...GL_VERSIONS,
        ...WGL_EXTENSIONS }))
    {
        for (const name of functions)
        {
            assert.ok(declared.has(name), `${extension}: ${name} has no stack size`);
            assert.ok(implemented.has(name), `${extension}: ${name} is not implemented`);
            assert.ok(!CORE_FUNCTIONS.has(name), `${extension}: ${name} is mistaken for core`);
        }
    }
    for (const name of declared)
    {
        assert.ok(EXTENSION_FUNCTIONS.has(name), `${name} is sized but belongs to no extension`);
        assert.ok(Object.values(ARGUMENT_WORDS).flat().includes(name), `${name} is not exported`);
    }
});

test('the extension string reports exactly what wglGetProcAddress can hand out', ()=>{
    const { table, cstring, readString } = library();
    const extensions = readString(table.glGetString.handler([GL.EXTENSIONS])).split(' ');
    assert.deepEqual(extensions,
        Object.keys(GL_EXTENSIONS).filter(name=>!HIDDEN_GL_EXTENSIONS.has(name)));

    for (const [extension, functions] of Object.entries(GL_EXTENSIONS))
    {
        for (const name of functions)
        {
            assert.notEqual(table.wglGetProcAddress.handler([cstring(name)]), 0,
                `${extension}: ${name} is reported and not obtainable`);
        }
    }
    // A hidden extension is one a program is not told about, not one that is
    // missing: its pointers are handed out and every one of them is real.
    for (const name of HIDDEN_GL_EXTENSIONS)
    {
        assert.ok(name in GL_EXTENSIONS, `${name} is hidden but not an extension`);
        assert.ok(!extensions.includes(name), `${name} is hidden and yet reported`);
    }
    assert.equal(table.wglGetProcAddress.handler([cstring('glEnable')]), 0, 'core is null');
    // A version's functions past 1.1 are obtained, as the DLL exports 1.1 alone.
    for (const [version, functions] of Object.entries(GL_VERSIONS))
    {
        for (const name of functions)
        {
            assert.notEqual(table.wglGetProcAddress.handler([cstring(name)]), 0,
                `${version}: ${name} is claimed and not obtainable`);
        }
        assert.ok(!extensions.includes(version), `${version} is not an extension's name`);
    }
    assert.equal(table.wglGetProcAddress.handler([cstring('glGetStringi')]), 0,
        'a function of a version past the one claimed is not');
    assert.equal(table.wglGetProcAddress.handler([cstring('glFrobnicateXYZ')]), 0);
    assert.equal(table.wglGetProcAddress.handler([0]), 0);

    const wglString = readString(table.wglGetExtensionsStringARB.handler([0x900d]));
    assert.deepEqual(wglString.split(' '), Object.keys(WGL_EXTENSIONS));
    assert.equal(table.wglGetExtensionsStringEXT.handler([]),
        table.wglGetExtensionsStringARB.handler([0x900d]), 'the same string, once');
});

test('the same name gets the same address every time, and it is the export\'s', ()=>{
    const { table, cstring, asked } = library();
    const first = table.wglGetProcAddress.handler([cstring('glActiveTextureARB')]);
    const second = table.wglGetProcAddress.handler([cstring('glActiveTextureARB')]);
    assert.equal(first, second);
    assert.deepEqual(asked, ['glActiveTextureARB', 'glActiveTextureARB']);
});

test('without a way to hand out addresses, nothing is advertised and nothing is obtainable',
    ()=>{
        const { table, cstring, readString } = library(false);
        assert.equal(readString(table.glGetString.handler([GL.EXTENSIONS])), '');
        assert.equal(table.wglGetProcAddress.handler([cstring('glActiveTextureARB')]), 0);
        assert.equal(table.wglGetProcAddress.handler([cstring('wglGetExtensionsStringARB')]), 0);
    });

test('the version string claims only what the entry points implement', ()=>{
    const { table, readString } = library();
    assert.equal(readString(table.glGetString.handler([GL.VERSION])), '2.1');
    assert.equal(readString(table.glGetString.handler([GL.SHADING_LANGUAGE_VERSION])), '1.20');
});

test('every state in the default table is in an attribute group or deliberately not saved', ()=>{
    for (const query of ALL_QUERIES)
    {
        const grouped = SERVER_BITS.has(query) || CLIENT_BITS.has(query);
        assert.ok(grouped !== NOT_SAVED.has(query),
            `query 0x${query.toString(16)} is ${grouped ? 'grouped and marked not saved'
                : 'neither grouped nor marked not saved'}`);
    }
    // A capability belongs to GL_ENABLE_BIT as well as to its own group.
    assert.equal(SERVER_BITS.get(GL.DEPTH_TEST), GL.ENABLE_BIT | GL.DEPTH_BUFFER_BIT);
    assert.equal(SERVER_BITS.get(GL.CURRENT_COLOR), GL.CURRENT_BIT);
    assert.equal(CLIENT_BITS.get(GL.UNPACK_ALIGNMENT), GL.CLIENT_PIXEL_STORE_BIT);
});
