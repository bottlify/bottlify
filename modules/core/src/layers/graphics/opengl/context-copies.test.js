/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the context copies and what it hands as it lies: a buffer's store is
 * read and packed in place where the caller only reads it or the call is the
 * write, and a snapshot the attribute stack pops or a vertex array object
 * reads is not cloned again. Each case counts the copies themselves, so a
 * copy put back fails it though the answers stay the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { TEX } from './formats.js';

/** Legacy enums the constants table does not name. */
const PIXEL_MAP_R_TO_R = 0x0c76;
const RED_SCALE = 0x0d14;

/** @returns {{ gl: any, bytes: Uint8Array, writes: Uint8Array[] }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    let next = 0x8000;
    /** @type {Uint8Array[]} what the context handed guest memory's write */
    const writes = [];
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>{
            writes.push(value);
            bytes.set(value, at);
        },
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 16) & ~15;
            return at;
        },
        free: ()=>{},
    } });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return { gl, bytes, writes };
}

/**
 * Runs `body` counting the calls of `prototype[method]` whose receiver
 * `which` accepts.
 *
 * @param {any} prototype @param {string} method
 * @param {(view: any) => boolean} which @param {() => void} body
 * @returns {number}
 */
function counted(prototype, method, which, body){
    const original = prototype[method];
    let count = 0;
    prototype[method] = function(/** @type {any[]} */ ...args){
        if (which(this))
        {
            count++;
        }
        return original.apply(this, args);
    };
    try
    {
        body();
    }
    finally
    {
        prototype[method] = original;
    }
    return count;
}

/** @param {ArrayBufferLike} buffer @param {() => void} body slices taken of `buffer`'s bytes */
const slicesOf = (buffer, body)=>counted(Uint8Array.prototype, 'slice',
    view=>view.buffer === buffer, body);

/** @param {any} prototype @param {() => void} body every slice of that kind */
const allSlices = (prototype, body)=>counted(prototype, 'slice', ()=>true, body);

/** @param {any} gl @param {number} target @param {number} size @returns {any} its store */
function storeOf(gl, target, size){
    const [name] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(target, name);
    gl.glBufferDataARB(target, size, 0, GL.STATIC_DRAW);
    return gl.shareGroup.buffers.objects.get(name);
}

test('glGetBufferSubData answers the store\'s bytes as they lie, no copy', ()=>{
    const { gl } = fixture();
    const store = storeOf(gl, GL.ARRAY_BUFFER, 16);
    store.data.set([1, 2, 3, 4], 4);
    /** @type {any} */
    let read;
    const copies = slicesOf(store.data.buffer, ()=>{
        read = gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 4, 4);
    });
    assert.deepEqual([...read], [1, 2, 3, 4]);
    assert.equal(copies, 0);
    assert.equal(read.buffer, store.data.buffer, 'the store\'s own bytes');
});

test('a persistent map is written from the store\'s own range', ()=>{
    const { gl, bytes, writes } = fixture();
    const [name] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
    gl.glBufferStorage(GL.ARRAY_BUFFER, 8, null, GL.MAP_WRITE_BIT | GL.MAP_PERSISTENT_BIT
        | GL.DYNAMIC_STORAGE_BIT);
    const at = gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 8, GL.MAP_WRITE_BIT
        | GL.MAP_PERSISTENT_BIT);
    const store = gl.shareGroup.buffers.objects.get(name);
    writes.length = 0;
    const copies = slicesOf(store.data.buffer, ()=>{
        gl.glBufferSubDataARB(GL.ARRAY_BUFFER, 2, 3, new Uint8Array([7, 8, 9]));
    });
    assert.deepEqual([...bytes.subarray(at, at + 8)], [0, 0, 7, 8, 9, 0, 0, 0]);
    assert.equal(copies, 0, 'the mirror wrote the store\'s range as it lies');
    assert.ok(writes.some(value=>value.buffer === store.data.buffer));
});

test('a pack into a pixel buffer is written in the store, an unpack read where it lies', ()=>{
    const { gl } = fixture();
    const unpack = storeOf(gl, GL.PIXEL_UNPACK_BUFFER, 160);
    const pack = storeOf(gl, GL.PIXEL_PACK_BUFFER, 160);
    unpack.data.fill(0x55, 16, 144);
    let copies = slicesOf(unpack.data.buffer, ()=>gl.glPolygonStipple(16));
    assert.equal(copies, 0, 'the stipple read from the unpack buffer where it lies');
    let sets = 0;
    copies = slicesOf(pack.data.buffer, ()=>{
        sets = counted(Uint8Array.prototype, 'set', view=>view === pack.data,
            ()=>gl.glGetPolygonStipple(32, null));
    });
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(copies, 0, 'packed into the pack buffer itself');
    assert.equal(sets, 0, 'and not set over itself after');
    assert.ok(pack.data.subarray(32, 160).every((/** @type {number} */ byte)=>byte === 0x55));
    copies = slicesOf(unpack.data.buffer, ()=>gl.glPixelMapfv(PIXEL_MAP_R_TO_R, 2, 16));
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(copies, 0, 'a pixel map read from the unpack buffer where it lies');
});

test('a popped attribute snapshot and a vertex array object\'s state are not cloned again', ()=>{
    const { gl } = fixture();
    gl.glLightfv(GL.LIGHT0, GL.DIFFUSE, [0.5, 0.25, 0.125, 1]);
    gl.glPushAttrib(GL.ALL_ATTRIB_BITS);
    gl.glPushClientAttrib(GL.CLIENT_ALL_ATTRIB_BITS);
    gl.glLightfv(GL.LIGHT0, GL.DIFFUSE, [1, 1, 1, 1]);
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = ()=>{
        throw new Error('cloned');
    };
    try
    {
        gl.glPopClientAttrib();
        gl.glPopAttrib();
        const [vao] = gl.glGenVertexArrays(1);
        gl.glBindVertexArray(vao);
        gl.glBindVertexArray(0);
        gl.glBindVertexArray(vao);
        const [made] = gl.glCreateVertexArrays(1);
        gl.glBindVertexArray(made);
    }
    finally
    {
        globalThis.structuredClone = clone;
    }
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual([...gl.glGetLightfv(GL.LIGHT0, GL.DIFFUSE)], [0.5, 0.25, 0.125, 1]);
});

test('a luminance level read back through the pixel transfer is copied once', ()=>{
    const { gl } = fixture();
    const [texture] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE, 2, 1, 0, GL.LUMINANCE, GL.UNSIGNED_BYTE,
        new Uint8Array([10, 20]));
    gl.glPixelTransferf(RED_SCALE, 2);
    /** @type {any} */
    let read;
    const copies = allSlices(Uint8Array.prototype, ()=>{
        read = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    });
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.ok(read);
    assert.equal(copies, 1, 'the transfer\'s copy, then table 6.1 in place');
});

test('stipple words read from memory are kept as read, a caller\'s words are copied', ()=>{
    const { gl } = fixture();
    const unpack = storeOf(gl, GL.PIXEL_UNPACK_BUFFER, 160);
    unpack.data.fill(0x33, 16, 144);
    const copies = allSlices(Uint32Array.prototype, ()=>gl.glPolygonStipple(16));
    assert.equal(copies, 0, 'the words read are this call\'s own');
    gl.glBindBufferARB(GL.PIXEL_UNPACK_BUFFER, 0);
    const words = new Uint32Array(32).fill(0x0f0f0f0f);
    gl.glPolygonStipple(words);
    const pack = storeOf(gl, GL.PIXEL_PACK_BUFFER, 256);
    gl.glGetPolygonStipple(0, null);
    words.fill(0);
    gl.glGetPolygonStipple(128, null);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.ok(pack.data.subarray(0, 128).some((/** @type {number} */ byte)=>byte !== 0));
    assert.deepEqual([...pack.data.subarray(128)], [...pack.data.subarray(0, 128)],
        'the pattern as it was given');
});

test('a compressed level\'s blocks are answered as they are kept', ()=>{
    const { gl } = fixture();
    const [texture] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    const block = new Uint8Array([255, 255, 0, 0, 0, 0, 0, 0]);
    gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, TEX.COMPRESSED_RED_RGTC1, 4, 4, 0, 8, block);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    /** @type {any} */
    let blocks;
    const copies = allSlices(Uint8Array.prototype, ()=>{
        blocks = gl.glGetCompressedTexImageARB(GL.TEXTURE_2D, 0);
    });
    assert.deepEqual([...blocks], [...block]);
    assert.equal(copies, 0);
});
