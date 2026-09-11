/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IJL, IJL_ORDINALS, createIjlLibrary } from './ijl.js';
import { FLAT, block, encode } from './jpeg.fixture.js';

/** A flat guest memory, with the structure and the buffers laid where a test says. */
function guest(){
    const memory = new Uint8Array(0x20000);
    let next = 0x10000;
    const lib = createIjlLibrary({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
    });
    const view = new DataView(memory.buffer);
    return {
        memory, view,
        fns: lib.libraries['ijl15.dll'],
        ordinals: lib.ordinals['ijl15.dll'],
        diagnostics: lib.diagnostics,
        /** @param {number} at @param {Uint8Array} bytes */
        place(at, bytes){
            memory.set(bytes, at);
        },
        /** @param {number} at @param {number} value */
        u32(at, value){
            view.setUint32(at, value >>> 0, true);
        },
        /** @param {number} at */
        read32: at=>view.getUint32(at, true),
        /** @param {number} at */
        cstring(at){
            let s = '';
            for (let i = at; memory[i]; i++)
            {
                s += String.fromCharCode(memory[i]);
            }
            return s;
        },
    };
}

const PROPS = 0x1000;
const JPEG_AT = 0x4000;
const DIB_AT = 0x8000;
// The layout a program compiled against the library's header uses; a wrong
// word here is exactly the defect that gets a decode refused as bad properties.
const OFF = { DIBBytes: 4, DIBWidth: 8, DIBHeight: 12, DIBPadBytes: 16, DIBChannels: 20,
    DIBColor: 24, JPGBytes: 36, JPGSizeBytes: 40, JPGWidth: 44, JPGHeight: 48,
    JPGChannels: 52, JPGColor: 56, jquality: 72 };

/** A four-component 8x8 picture with distinct flat channels: 138, 148, 158, 168. */
const FOUR = encode({ width: 8, height: 8, quant: FLAT,
    components: [10, 20, 30, 40].map(dc=>({ h: 1, v: 1, blocks: [block(dc * 8)] })) });

test('the exports carry the ordinals the shipped library has', ()=>{
    // A program imports this library by number, so the numbers are the
    // contract: bound one off, ijlRead would be answered by ijlFree.
    assert.deepEqual(IJL_ORDINALS, {
        1: 'ijlGetLibVersion', 2: 'ijlInit', 3: 'ijlFree', 4: 'ijlRead', 5: 'ijlWrite',
        6: 'ijlErrorStr',
    });
    const g = guest();
    assert.deepEqual(Object.keys(g.fns).sort(), Object.values(g.ordinals).sort());
});

test('init clears the structure and sets the default quality', ()=>{
    const g = guest();
    g.memory.fill(0xaa, PROPS, PROPS + 80);
    assert.equal(g.fns.ijlInit.handler([PROPS]), IJL.OK);
    assert.equal(g.read32(PROPS + OFF.DIBBytes), 0);
    assert.equal(g.read32(PROPS + OFF.jquality), 75);
    assert.equal(g.fns.ijlInit.handler([0]), IJL.INVALID_JPEG_PROPERTIES);
});

test('reading the parameters of a buffer describes the picture without decoding it', ()=>{
    const g = guest();
    g.fns.ijlInit.handler([PROPS]);
    g.place(JPEG_AT, FOUR);
    g.u32(PROPS + OFF.JPGBytes, JPEG_AT);
    g.u32(PROPS + OFF.JPGSizeBytes, FOUR.length);

    assert.equal(g.fns.ijlRead.handler([PROPS, 1]), IJL.OK, 'IJL_JBUFF_READPARAMS');
    assert.equal(g.read32(PROPS + OFF.JPGWidth), 8);
    assert.equal(g.read32(PROPS + OFF.JPGHeight), 8);
    assert.equal(g.read32(PROPS + OFF.JPGChannels), 4);
    assert.equal(g.read32(PROPS + OFF.JPGColor), 255,
        'four components are the caller\'s own: IJL_OTHER');
    assert.equal(g.diagnostics().decoded, 0, 'nothing decoded yet');
});

test('the whole image lands in the DIB, four channels as they lie', ()=>{
    const g = guest();
    g.fns.ijlInit.handler([PROPS]);
    g.place(JPEG_AT, FOUR);
    g.u32(PROPS + OFF.JPGBytes, JPEG_AT);
    g.u32(PROPS + OFF.JPGSizeBytes, FOUR.length);
    g.u32(PROPS + OFF.DIBWidth, 8);
    g.u32(PROPS + OFF.DIBHeight, 8);
    g.u32(PROPS + OFF.DIBChannels, 4);
    g.u32(PROPS + OFF.DIBColor, 255);
    g.u32(PROPS + OFF.DIBBytes, DIB_AT);

    assert.equal(g.fns.ijlRead.handler([PROPS, 3]), IJL.OK, 'IJL_JBUFF_READWHOLEIMAGE');
    assert.deepEqual([...g.memory.subarray(DIB_AT, DIB_AT + 8)],
        [138, 148, 158, 168, 138, 148, 158, 168]);
    assert.equal(g.read32(PROPS + OFF.JPGWidth), 8, 'the JPG side is described too');
    assert.equal(g.diagnostics().decoded, 1);
    assert.equal(g.fns.ijlFree.handler([PROPS]), IJL.OK);
    assert.equal(g.diagnostics().open, 0);
});

test('rows keep the picture\'s order, a negative height reverses them, padding is honoured', ()=>{
    // Two rows of blocks with different levels, so the order of rows shows.
    // A program reading a texture atlas out of the DIB depends on the order:
    // delivered upside down, the atlas hands it the wrong cells.
    const bytes = encode({ width: 8, height: 16, quant: FLAT,
        components: [{ h: 1, v: 1, blocks: [block(80), block(-80)] }] });
    /** @param {number} signedHeight */
    const read = signedHeight=>{
        const g = guest();
        g.fns.ijlInit.handler([PROPS]);
        g.place(JPEG_AT, bytes);
        g.u32(PROPS + OFF.JPGBytes, JPEG_AT);
        g.u32(PROPS + OFF.JPGSizeBytes, bytes.length);
        g.u32(PROPS + OFF.DIBWidth, 8);
        g.u32(PROPS + OFF.DIBHeight, signedHeight);
        g.u32(PROPS + OFF.DIBPadBytes, 2);
        g.u32(PROPS + OFF.DIBChannels, 1);
        g.u32(PROPS + OFF.DIBColor, 4);
        g.u32(PROPS + OFF.DIBBytes, DIB_AT);
        assert.equal(g.fns.ijlRead.handler([PROPS, 3]), IJL.OK);
        return g.memory;
    };
    const stride = 8 + 2;
    const up = read(16);
    assert.equal(up[DIB_AT], 138, 'the first row in memory is the top of the picture');
    assert.equal(up[DIB_AT + 15 * stride], 118, 'and the last is the bottom');
    const down = read(-16);
    assert.equal(down[DIB_AT], 118, 'a negative height puts the bottom row first');
    assert.equal(down[DIB_AT + 15 * stride], 138);
});

test('what the library cannot do is refused with its own codes and named', ()=>{
    const g = guest();
    g.fns.ijlInit.handler([PROPS]);
    assert.equal(g.fns.ijlRead.handler([PROPS, 1]), IJL.INVALID_JPEG_PROPERTIES, 'no buffer');
    g.place(JPEG_AT, Uint8Array.of(1, 2, 3, 4));
    g.u32(PROPS + OFF.JPGBytes, JPEG_AT);
    g.u32(PROPS + OFF.JPGSizeBytes, 4);
    assert.equal(g.fns.ijlRead.handler([PROPS, 1]), IJL.ERR_DATA, 'not a JPEG');
    assert.equal(g.fns.ijlRead.handler([PROPS, 0]), IJL.FILE_ERROR, 'by file name');
    assert.equal(g.fns.ijlWrite.handler([PROPS, 8]), IJL.INVALID_ENCODER);
    assert.equal(g.cstring(g.fns.ijlErrorStr.handler([IJL.ERR_DATA])), 'IJL_ERR_DATA');
    const once = g.fns.ijlErrorStr.handler([IJL.ERR_DATA]);
    assert.equal(g.fns.ijlErrorStr.handler([IJL.ERR_DATA]), once, 'one string, one address');
    const version = g.fns.ijlGetLibVersion.handler([]);
    assert.equal(g.read32(version), 1);
    assert.equal(g.read32(version + 4), 5);
    assert.equal(g.cstring(g.read32(version + 12)), 'Intel(R) JPEG Library');
});
