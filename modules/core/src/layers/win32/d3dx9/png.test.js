/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PngError, readPng } from './png.js';

/** @param {string} type @param {number[] | Uint8Array} body */
function chunk(type, body){
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set([...type].map(c=>c.charCodeAt(0)), 4);
    out.set(body, 8);
    // The CRC is not checked by the reader; zero stands in for it.
    return out;
}

/**
 * A PNG of the given header fields and filtered rows (each row its filter byte first).
 *
 * @param {{ width: number, height: number, depth: number, colour: number, interlace?: number,
 *     palette?: number[], trns?: number[] }} h
 * @param {number[]} raw
 */
function png(h, raw){
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, h.width);
    view.setUint32(4, h.height);
    ihdr.set([h.depth, h.colour, 0, 0, h.interlace ?? 0], 8);
    const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        chunk('IHDR', ihdr)];
    if (h.palette)
    {
        parts.push(chunk('PLTE', h.palette));
    }
    if (h.trns)
    {
        parts.push(chunk('tRNS', h.trns));
    }
    const z = deflateSync(Uint8Array.from(raw));
    // Image data split across two IDAT chunks, which the reader joins.
    parts.push(chunk('IDAT', z.subarray(0, 5)), chunk('IDAT', z.subarray(5)), chunk('IEND', []));
    return Uint8Array.from(parts.flatMap(p=>[...p]));
}

/** @param {Uint8Array} bgra */
const pixels = bgra=>Array.from({ length: bgra.length / 4 }, (_, i)=>[...bgra.subarray(i * 4,
    i * 4 + 4)]);

test('an RGBA PNG reads into B, G, R, A, as A8R8G8B8', ()=>{
    const image = readPng(png({ width: 2, height: 1, depth: 8, colour: 6 },
        [0, 10, 20, 30, 40, 50, 60, 70, 80]));
    assert.equal(image.format, 21);
    assert.deepEqual(pixels(image.bgra), [[30, 20, 10, 40], [70, 60, 50, 80]]);
});

test('every row filter is undone against the row before it', ()=>{
    // Two rows of RGB, the second under each filter in turn, all meaning the same pixels.
    const top = [10, 20, 30, 40, 50, 60];
    const want = [[30, 20, 10, 255], [60, 50, 40, 255], [33, 22, 11, 255], [66, 55, 44, 255]];
    const bottom = [11, 22, 33, 44, 55, 66];
    const paeth = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c)=>{
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const encode = [
        ()=>bottom,
        ()=>bottom.map((v, i)=>(v - (i >= 3 ? bottom[i - 3] : 0)) & 0xff),
        ()=>bottom.map((v, i)=>(v - top[i]) & 0xff),
        ()=>bottom.map((v, i)=>(v - (((i >= 3 ? bottom[i - 3] : 0) + top[i]) >> 1)) & 0xff),
        ()=>bottom.map((v, i)=>(v - paeth(i >= 3 ? bottom[i - 3] : 0, top[i],
            i >= 3 ? top[i - 3] : 0)) & 0xff),
    ];
    encode.forEach((make, filter)=>{
        const image = readPng(png({ width: 2, height: 2, depth: 8, colour: 2 },
            [0, ...top, filter, ...make()]));
        assert.deepEqual(pixels(image.bgra), want, `filter ${filter}`);
        assert.equal(image.format, 20, 'colour without alpha is R8G8B8');
    });
});

test('grey at every depth scales to eight bits; a palette takes its tRNS alpha', ()=>{
    // Two-bit grey: 0, 1, 2, 3 are 0, 85, 170, 255.
    const grey = readPng(png({ width: 4, height: 1, depth: 2, colour: 0 }, [0, 0b00011011]));
    assert.equal(grey.format, 50, 'L8');
    assert.deepEqual(pixels(grey.bgra).map(p=>p[0]), [0, 85, 170, 255]);
    const sixteen = readPng(png({ width: 1, height: 1, depth: 16, colour: 0 }, [0, 0xab, 0xcd]));
    assert.equal(sixteen.bgra[0], 0xab);
    assert.equal(sixteen.format, 36);
    const indexed = readPng(png({ width: 2, height: 1, depth: 4, colour: 3,
        palette: [255, 0, 0, 0, 0, 255], trns: [128] }, [0, 0x01]));
    assert.equal(indexed.format, 41, 'P8');
    assert.deepEqual(pixels(indexed.bgra), [[0, 0, 255, 128], [255, 0, 0, 255]]);
    // A grey's tRNS names one grey level transparent.
    const keyed = readPng(png({ width: 2, height: 1, depth: 8, colour: 0, trns: [0, 7] },
        [0, 7, 9]));
    assert.deepEqual(pixels(keyed.bgra), [[7, 7, 7, 0], [9, 9, 9, 255]]);
    assert.equal(keyed.format, 21);
});

test('an Adam7 image puts each pass\'s pixels where the pass says', ()=>{
    // 3x3 grey: pass 1 has (0,0); pass 4 (2,0); pass 5 (0,2),(2,2); pass 6 (1,0),(1,2);
    // pass 7 the middle row (0,1),(1,1),(2,1). Passes 2 and 3 are empty at this size.
    const value = (/** @type {number} */ x, /** @type {number} */ y)=>10 * y + x + 1;
    const raw = [0, value(0, 0), 0, value(2, 0), 0, value(0, 2), value(2, 2),
        0, value(1, 0), 0, value(1, 2), 0, value(0, 1), value(1, 1), value(2, 1)];
    const image = readPng(png({ width: 3, height: 3, depth: 8, colour: 0, interlace: 1 }, raw));
    assert.deepEqual(pixels(image.bgra).map(p=>p[0]),
        [1, 2, 3, 11, 12, 13, 21, 22, 23]);
});

test('what is not a PNG this specification allows is refused by name', ()=>{
    assert.throws(()=>readPng(Uint8Array.of(1, 2, 3)), PngError);
    assert.throws(()=>readPng(png({ width: 1, height: 1, depth: 4, colour: 2 }, [0, 0])),
        /header this specification does not allow/);
    assert.throws(()=>readPng(png({ width: 1, height: 1, depth: 8, colour: 3 }, [0, 0])),
        /without its PLTE/);
    assert.throws(()=>readPng(png({ width: 1, height: 1, depth: 8, colour: 0 }, [5, 0])),
        /row filter 5/);
    const whole = png({ width: 1, height: 1, depth: 8, colour: 0 }, [0, 0]);
    assert.throws(()=>readPng(whole.subarray(0, whole.length - 12)), /cut short/);
});
