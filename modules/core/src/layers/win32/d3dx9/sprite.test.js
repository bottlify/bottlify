/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPRITE, createSprites } from './sprite.js';
import { createFonts } from './font.js';

/**
 * Guest memory, a heap, and a device whose methods are reached through the
 * vtable a pointer leads to, as a program reaches them; each call recorded.
 */
function rig(){
    const memory = new Uint8Array(1 << 20);
    const view = new DataView(memory.buffer);
    let next = 0x1000;
    const heap = {
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        free: ()=>{},
    };
    /** @type {any[]} */
    const calls = [];
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @param {any} state */
    const object = state=>{
        const at = heap.allocate(4);
        const vtable = heap.allocate(128 * 4);
        view.setUint32(at, vtable, true);
        for (let slot = 0; slot < 128; slot++)
        {
            view.setUint32(vtable + slot * 4, 0xe0000 + slot, true);
        }
        objects.set(at, state);
        return at;
    };
    const device = object({ kind: 'device' });
    const texture = object({ kind: 'texture', width: 64, height: 32,
        data: heap.allocate(64 * 32 * 4) });
    const other = object({ kind: 'texture', width: 16, height: 16,
        data: heap.allocate(16 * 16 * 4) });
    let inHandler = false;
    const callGuest = async(/** @type {{ entry: number, args: number[] }} */ { entry, args })=>{
        if (inHandler)
        {
            throw new Error('a call into the guest before the handler returned');
        }
        const slot = entry - 0xe0000;
        const self = objects.get(args[0]);
        if (self.kind === 'device')
        {
            switch (slot)
            {
                case 23: {
                    const [, width, height, , , format, pool, out] = args;
                    const made = object({ kind: 'texture', width, height, format, pool,
                        data: heap.allocate(width * height * 4) });
                    view.setUint32(out, made, true);
                    calls.push(['CreateTexture', width, height, format, pool]);
                    return 0;
                }
                case 59: {
                    view.setUint32(args[2], object({ kind: 'block' }), true);
                    calls.push(['CreateStateBlock', args[1]]);
                    return 0;
                }
                case 83: {
                    const [, type, count, data, stride] = args;
                    calls.push(['DrawPrimitiveUP', type, count, stride,
                        Array.from({ length: count * 3 }, (_, k)=>[
                            view.getFloat32(data + k * stride, true),
                            view.getFloat32(data + k * stride + 4, true),
                            view.getUint32(data + k * stride + 16, true),
                            view.getFloat32(data + k * stride + 20, true),
                            view.getFloat32(data + k * stride + 24, true)])]);
                    return 0;
                }
                case 65:
                    calls.push(['SetTexture', args[1], args[2]]);
                    return 0;
                case 57:
                    calls.push(['SetRenderState', args[1], args[2]]);
                    return 0;
                default:
                    calls.push([`device ${slot}`]);
                    return 0;
            }
        }
        if (self.kind === 'texture')
        {
            if (slot === 17)
            {
                view.setUint32(args[2] + 24, self.width, true);
                view.setUint32(args[2] + 28, self.height, true);
                return 0;
            }
            if (slot === 19)
            {
                view.setUint32(args[2], self.width * 4, true);
                view.setUint32(args[2] + 4, self.data, true);
                return 0;
            }
            return 0;
        }
        calls.push([`${self.kind} ${slot}`]);
        return 0;
    };
    let published = 0x90000000;
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        heap, callGuest,
        vtables: { publish: ()=>(published += 4) },
        // A font engine whose every glyph is a 2x3 block, fully inked, 5 wide.
        glyph: (/** @type {number} */ code)=>(code === 32
            ? { advance: 5, left: 0, top: 0, width: 0, height: 0, coverage: new Uint8Array(0) }
            : { advance: 5, left: 1, top: 2, width: 2, height: 3,
                coverage: new Uint8Array(6).fill(200) }),
        fontMetrics: ()=>({ height: 10, ascent: 8, descent: 2, internalLeading: 0,
            externalLeading: 0, aveCharWidth: 5, maxCharWidth: 5 }),
    };
    const sprites = createSprites(host);
    const fonts = createFonts(host, sprites);
    /**
     * A method of the descriptor, the way the bridge calls it: the handler's
     * return comes before any call it makes into the guest.
     *
     * @param {any} descriptor @param {string} name @param {any} target @param {number[]} args
     */
    const invoke = (descriptor, name, target, args)=>{
        const one = descriptor.methods.find((/** @type {any} */ m)=>m.name === name);
        inHandler = true;
        try
        {
            return one.invoke(target, args);
        }
        finally
        {
            inHandler = false;
        }
    };
    return { memory, view, heap, device, texture, other, calls, sprites, fonts, invoke, objects,
        host };
}

/** @param {any} r @param {number[]} values */
function vector(r, values){
    const at = r.heap.allocate(12);
    new Float32Array(r.memory.buffer, at, 3).set(values);
    return at;
}

test('a sprite batch saves the device\'s state, draws a run of one texture at once, and '
    + 'puts the state back', async()=>{
    const r = rig();
    const { object } = r.sprites.create(r.device);
    assert.equal(await r.invoke(r.sprites.sprite, 'Begin', object, [SPRITE.ALPHABLEND]), 0);
    const center = vector(r, [32, 16, 0]);
    const position = vector(r, [100, 50, 0]);
    assert.equal(r.invoke(r.sprites.sprite, 'Draw', object,
        [r.texture, 0, center, position, 0xff112233]), 0);
    const rect = r.heap.allocate(16);
    new Int32Array(r.memory.buffer, rect, 4).set([0, 0, 32, 16]);
    assert.equal(r.invoke(r.sprites.sprite, 'Draw', object,
        [r.texture, rect, 0, position, 0x80ffffff]), 0);
    r.invoke(r.sprites.sprite, 'Draw', object, [r.other, 0, 0, 0, 0xffffffff]);
    assert.equal(await r.invoke(r.sprites.sprite, 'End', object, []), 0);

    assert.deepEqual(r.calls[0], ['CreateStateBlock', 1]);
    assert.ok(r.calls.some(c=>c[0] === 'SetRenderState' && c[1] === 27 && c[2] === 1),
        'alpha blending on');
    const draws = r.calls.filter(c=>c[0] === 'DrawPrimitiveUP');
    assert.deepEqual(draws.map(d=>[d[1], d[2], d[3]]), [[4, 4, 28], [4, 2, 28]],
        'two sprites of one texture in one draw, the other in its own');
    // The first sprite: centred on its position, the whole 64x32 texture, half a pixel back.
    const [x0, y0, colour0, u0, v0] = draws[0][4][0];
    assert.deepEqual([x0, y0, colour0, u0, v0], [67.5, 33.5, 0xff112233, 0, 0]);
    assert.deepEqual(draws[0][4][4].slice(0, 2), [131.5, 65.5]);
    // The second: its rectangle, half the texture each way.
    assert.deepEqual(draws[0][4][10].slice(3), [0.5, 0.5]);
    const textures = r.calls.filter(c=>c[0] === 'SetTexture').map(c=>c[2]);
    assert.deepEqual(textures, [r.texture, r.other]);
    assert.deepEqual(r.calls.slice(-2), [['block 5'], ['block 2']], 'applied, then released');
});

test('a sprite out of a Begin refuses to draw; DONOTSAVESTATE makes no state block', async()=>{
    const r = rig();
    const { object } = r.sprites.create(r.device);
    assert.equal(r.invoke(r.sprites.sprite, 'Draw', object, [r.texture, 0, 0, 0, 0]) >>> 0,
        0x8876086c);
    await r.invoke(r.sprites.sprite, 'Begin', object, [SPRITE.DONOTSAVESTATE]);
    await r.invoke(r.sprites.sprite, 'End', object, []);
    assert.equal(r.calls.filter(c=>c[0] === 'CreateStateBlock').length, 0);
});

test('text is drawn from glyphs kept in a page, its lines laid out as DrawText does',
    async()=>{
        const r = rig();
        const out = r.heap.allocate(4);
        assert.equal(r.fonts.create(r.device, { height: -10, width: 0, weight: 400, mipLevels: 1,
            italic: 0, charSet: 0, outputPrecision: 0, quality: 0, pitchAndFamily: 0,
            faceName: 'Arial' }, out), 0);
        const pointer = r.view.getUint32(out, true);
        assert.notEqual(pointer, 0);
        // The font object, as the descriptor's methods are handed it.
        const font = { state: { device: r.device, desc: { height: -10, weight: 400,
            italic: 0, charSet: 0, pitchAndFamily: 0, faceName: 'Arial' },
        logFont: {}, glyphs: new Map(), pages: [] } };
        const text = r.heap.allocate(16);
        r.memory.set([...'ab cd'].map(c=>c.charCodeAt(0)), text);
        const rect = r.heap.allocate(16);
        new Int32Array(r.memory.buffer, rect, 4).set([10, 20, 22, 100]);
        // DT_CALCRECT | DT_WORDBREAK in a rectangle 12 wide: "ab" and "cd" on two lines.
        assert.equal(await r.invoke(r.fonts.font, 'DrawTextA', font,
            [0, text, 5, rect, 0x410, 0xffffffff]), 20);
        assert.deepEqual([...new Int32Array(r.memory.buffer, rect, 4)], [10, 20, 20, 40]);
        assert.equal(r.calls.length, 0, 'measuring draws nothing');

        new Int32Array(r.memory.buffer, rect, 4).set([0, 0, 40, 10]);
        // DT_CENTER | DT_SINGLELINE: one line 25 wide, centred in 40.
        assert.equal(await r.invoke(r.fonts.font, 'DrawTextA', font,
            [0, text, -1, rect, 0x21, 0xff00ff00]), 10);
        const made = r.calls.find(c=>c[0] === 'CreateTexture');
        assert.deepEqual(made, ['CreateTexture', 256, 256, 21, 1]);
        const draw = r.calls.find(c=>c[0] === 'DrawPrimitiveUP');
        assert.equal(draw[2], 8, 'four inked glyphs, the space has none');
        // The first glyph: pen at 7 (centred), its ink 1 right and 2 down, half a pixel back.
        assert.deepEqual(draw[4][0].slice(0, 3), [7.5, 1.5, 0xff00ff00]);
        // Its coverage is in the page's alpha, white above it.
        const pageObject = [...r.objects.values()].find(o=>o.width === 256);
        const texel = (/** @type {number} */ x, /** @type {number} */ y)=>
            [...r.memory.subarray(pageObject.data + (y * 256 + x) * 4,
                pageObject.data + (y * 256 + x) * 4 + 4)];
        assert.deepEqual(texel(1, 1), [255, 255, 255, 200]);
        assert.deepEqual(texel(0, 0), [255, 255, 255, 0]);
    });

test('text to its NUL ending just short of the end of its memory is read without reading past it',
    async()=>{
        // Past the end lies another allocation, or nothing: memory refuses a read
        // that runs into it, as the memory layer refuses one past a region's end.
        const r = rig();
        const end = r.memory.length;
        const read = r.host.readMemory;
        r.host.readMemory = (/** @type {number} */ at, /** @type {number} */ length)=>{
            assert.ok(at + length <= end,
                `read of ${length} bytes at 0x${at.toString(16)} runs past the end of memory`);
            return read(at, length);
        };
        const font = { state: { device: r.device, desc: { height: -10, weight: 400,
            italic: 0, charSet: 0, pitchAndFamily: 0, faceName: 'Arial' },
        logFont: {}, glyphs: new Map(), pages: [] } };
        const rect = r.heap.allocate(16);
        const ansi = end - 8 - 6;
        r.memory.set([...'ab cd\0'].map(c=>c.charCodeAt(0)), ansi);
        new Int32Array(r.memory.buffer, rect, 4).set([10, 20, 22, 100]);
        // DT_CALCRECT | DT_WORDBREAK in a rectangle 12 wide: "ab" and "cd" on two lines.
        assert.equal(await r.invoke(r.fonts.font, 'DrawTextA', font,
            [0, ansi, -1, rect, 0x410, 0xffffffff]), 20);
        const wide = end - 8 - 12;
        r.memory.set(new Uint8Array(Uint16Array.from('ab cd\0', c=>c.charCodeAt(0)).buffer), wide);
        new Int32Array(r.memory.buffer, rect, 4).set([10, 20, 22, 100]);
        assert.equal(await r.invoke(r.fonts.font, 'DrawTextW', font,
            [0, wide, -1, rect, 0x410, 0xffffffff]), 20);
    });
