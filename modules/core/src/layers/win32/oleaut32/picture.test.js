/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The standard picture against Wine's olepicture.c expectations: what
 * OleCreatePictureIndirect wraps, what OleLoadPicture reads out of a stream,
 * the HIMETRIC size at 96 pixels an inch, Render's upright source rectangle,
 * and a handle the picture owns given back with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from './objects.js';
import {
    CTL_E_INVALIDPICTURE, IID_IPICTURE, IID_IPICTUREDISP, PICTYPE, createPictureObjects,
} from './picture.js';

const S_OK = 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const DESC = 0x100;
const OUT = 0x200;
const SCRATCH = 0x300;
const STREAM = 0x400;
const HBITMAP = 0x5000;

/**
 * Pictures over fake guest memory, GDI and user32 that record their calls,
 * and a stream whose Read and Write are fake guest methods.
 *
 * @param {Uint8Array} [streamBytes]
 */
function setup(streamBytes = new Uint8Array(0)){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    let next = 0x20000;
    /** @type {Set<number>} */
    const held = new Set();
    /** @type {any[][]} */
    const calls = [];
    /** @type {any[]} */
    const published = [];
    /** @type {string[]} */
    const said = [];
    let streamAt = 0;
    /** @type {number[]} */
    const written = [];
    // The stream's vtable: QueryInterface, AddRef, Release, Read (0x7003), Write (0x7004).
    view.setUint32(STREAM, STREAM + 0x10, true);
    view.setUint32(STREAM + 0x10 + 12, 0x7003, true);
    view.setUint32(STREAM + 0x10 + 16, 0x7004, true);
    const pictures = createPictureObjects({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        allocate: size=>{
            const at = next;
            next += (size + 15) & ~15;
            held.add(at);
            return at;
        },
        free: address=>{
            assert.ok(held.delete(address), 'only what was allocated is freed');
        },
        gdi32: (name, args)=>{
            calls.push([name, ...args]);
            if (name === 'GetObjectW')
            {
                // BITMAP: bmType, bmWidth 32, bmHeight 16.
                view.setInt32(args[2] + 4, 32, true);
                view.setInt32(args[2] + 8, 16, true);
                return 24;
            }
            return name === 'CreateDIBitmap' ? HBITMAP + 1 : name === 'CreateCompatibleDC'
                ? 0x77 : 1;
        },
        user32: (name, args)=>{
            calls.push([name, ...args]);
            return name === 'GetDC' ? 0x66 : name === 'GetSystemMetrics' ? 32 : 1;
        },
        publish: (object, id)=>{
            published.push({ object, id });
            return 0x9000 + published.length * 0x10;
        },
        adapt: (state, interfaces, destroy)=>createAdapter(state, interfaces, destroy),
        call: async(entry, args)=>{
            if (entry === 0x7003)
            {
                const [, buffer, wanted, readOut] = args;
                const piece = streamBytes.subarray(streamAt, streamAt + wanted);
                bytes.set(piece, buffer);
                streamAt += piece.length;
                view.setUint32(readOut, piece.length, true);
                return S_OK;
            }
            const [, buffer, count] = args;
            written.push(...bytes.subarray(buffer, buffer + count));
            return S_OK;
        },
        callerThread: ()=>null,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    /**
     * A method of the last object published, by name, called as the guest would.
     *
     * @param {string} iid @param {string} name @param {number[]} args
     */
    const method = (iid, name, ...args)=>{
        const object = published[published.length - 1].object;
        const entry = object.interfaceFor(iid).methods.find((/** @type {any} */ m)=>m.name === name);
        return entry.invoke(object, args);
    };
    return { pictures, view, bytes, calls, published, method, said, written, held };
}

test('a bitmap is wrapped at its size in HIMETRIC, and drawn upright from the source'
    + ' rectangle a program names', async()=>{
    const { pictures, view, calls, published, method, held } = setup();
    view.setUint32(DESC, 16, true);
    view.setInt32(DESC + 4, PICTYPE.BITMAP, true);
    view.setUint32(DESC + 8, HBITMAP, true);
    assert.equal(pictures.create(DESC, IID_IPICTURE, true, OUT), S_OK);
    assert.equal(view.getUint32(OUT, true), published.length * 0x10 + 0x9000);
    method(IID_IPICTURE, 'get_Type', SCRATCH);
    assert.equal(view.getInt16(SCRATCH, true), PICTYPE.BITMAP);
    method(IID_IPICTURE, 'get_Handle', SCRATCH);
    assert.equal(view.getUint32(SCRATCH, true), HBITMAP);
    method(IID_IPICTURE, 'get_Width', SCRATCH);
    const width = view.getInt32(SCRATCH, true);
    method(IID_IPICTURE, 'get_Height', SCRATCH);
    const height = view.getInt32(SCRATCH, true);
    assert.deepEqual([width, height], [847, 423], '32 by 16 pixels at 96 an inch');
    calls.length = 0;
    assert.equal(await method(IID_IPICTURE, 'Render', 0x55, 10, 20, 64, 32, 0, height, width,
        -height, 0), S_OK);
    assert.deepEqual(calls.find(call=>call[0] === 'StretchBlt'),
        ['StretchBlt', 0x55, 10, 20, 64, 32, 0x77, 0, 0, 32, 16, 0x00cc0020],
        'the whole bitmap, top row first');
    assert.equal(method(IID_IPICTURE, 'Render', 0x55, 10, 20, 0, 32, 0, height, width, -height,
        0), E_INVALIDARG);
    calls.length = 0;
    published[published.length - 1].object.release();
    assert.deepEqual(calls, [['DeleteObject', HBITMAP]], 'an owned handle goes with it');
    assert.equal(held.size, 0);
});

test('NULL is an uninitialised picture; an interface it has not is refused', ()=>{
    const { pictures, view, method } = setup();
    assert.equal(pictures.create(0, IID_IPICTUREDISP, false, OUT), S_OK);
    method(IID_IPICTUREDISP, 'Invoke', 3, 0, 0, 2, 0, SCRATCH, 0, 0);
    assert.deepEqual([view.getUint16(SCRATCH, true), view.getInt32(SCRATCH + 8, true)],
        [2, PICTYPE.UNINITIALIZED], 'Type through the dispinterface: a VT_I2');
    assert.equal(pictures.create(0, '{00000001-0000-0000-C000-000000000046}', false, OUT),
        E_NOINTERFACE);
    assert.equal(view.getUint32(OUT, true), 0);
});

/** A 2 by 1 BMP, 24 bits a pixel, rows padded to 8 bytes. */
function bmp(){
    const file = new Uint8Array(62);
    const view = new DataView(file.buffer);
    file.set([0x42, 0x4d]);
    view.setUint32(2, file.length, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 2, true);
    view.setInt32(22, 1, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    return file;
}

test('a BMP in a stream is a bitmap compatible with the screen, and saved as it came', async()=>{
    const file = bmp();
    const { pictures, view, calls, method, written, held } = setup(file);
    assert.equal(await pictures.load(STREAM, 0, IID_IPICTURE, OUT), S_OK);
    const made = calls.find(call=>call[0] === 'CreateDIBitmap');
    assert.ok(made);
    assert.equal(made[1], 0x66, 'with the screen\'s DC');
    assert.ok(calls.some(call=>call[0] === 'ReleaseDC'), 'given back');
    method(IID_IPICTURE, 'get_Handle', SCRATCH);
    assert.equal(view.getUint32(SCRATCH, true), HBITMAP + 1);
    method(IID_IPICTURE, 'get_Width', SCRATCH);
    assert.equal(view.getInt32(SCRATCH, true), 53, '2 pixels');
    assert.equal(await method(IID_IPICTURE, 'SaveAsFile', STREAM, 1, SCRATCH), S_OK);
    assert.deepEqual(written, [...file]);
    assert.equal(view.getUint32(SCRATCH, true), file.length);
    assert.equal(held.size, 0);
});

test('a saved StdPicture\'s "lt" header is read past; bytes of no picture are refused, said',
    async()=>{
        const file = bmp();
        const saved = new Uint8Array(8 + file.length);
        const view = new DataView(saved.buffer);
        view.setUint32(0, 0x0000746c, true);
        view.setUint32(4, file.length, true);
        saved.set(file, 8);
        assert.equal(await setup(saved).pictures.load(STREAM, 0, IID_IPICTURE, OUT), S_OK);
        const junk = setup(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        assert.equal(await junk.pictures.load(STREAM, 0, IID_IPICTURE, OUT),
            CTL_E_INVALIDPICTURE);
        assert.match(junk.said.join('\n'), /OleLoadPicture: 8 bytes/);
    });
