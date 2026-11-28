/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the glyphs kept as pages of the run's cache (`fonts.js`):
 * seeded programs of strings in several faces, sizes, weights, styles and
 * qualities - codes of the program's ANSI bytes and wide ones, several pages
 * of a face - measured and drawn through an engine that keeps its pages in
 * the run's cache and through one over a space that keeps nothing, which
 * draws every page again at each read. The cache is now and then left idle
 * long enough to let pages go, and one is too small to take them all, so a
 * page is drawn again glyph by glyph and refused room. Everything a program can observe must be the
 * same:
 * every glyph's advance, box and coverage (what GetGlyphOutline and
 * GetCharABCWidths answer from), each string's extent (what DrawText and
 * GetTextExtentPoint measure) and every pixel TextOut leaves on the DC.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NONANTIALIASED_QUALITY, PAGE_CODES, createFontEngine } from './fonts.js';
import { extTextOut, textExtent } from './text.js';
import { OPAQUE, TRANSPARENT } from './brush.js';
import { createPainter } from './shapes.js';
import { clearSurface, createSurface } from './surface.js';
import { testCache, testScratch } from '../../cache/testing.fixture.js';

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/**
 * A 2D context that draws a glyph of its own for every character: its width,
 * ink box and coverage follow from the character and the font, so two codes
 * or two fonts never draw alike, and the same code and font always do.
 */
function fakeCanvas(){
    let width = 0;
    let height = 0;
    /** @type {Uint8ClampedArray} */
    let pixels = new Uint8ClampedArray(0);
    let font = '';
    let dx = 0;
    let dy = 0;
    const em = ()=>Number(/(\d+)px/.exec(font)?.[1] ?? 0);
    const salt = ()=>[...font].reduce((sum, c)=>(sum * 31 + c.charCodeAt(0)) >>> 0, 7);
    /** @param {string} text */
    const advance = text=>[...text].reduce((sum, c)=>sum + em() * (0.3 + (c.charCodeAt(0) % 7)
        / 10), 0);
    /** @param {number} x @param {number} y @param {number} alpha */
    const plot = (x, y, alpha)=>{
        if (x >= 0 && y >= 0 && x < width && y < height)
        {
            pixels[(y * width + x) * 4 + 3] = alpha;
        }
    };
    const context = {
        get font(){
            return font;
        },
        set font(value){
            font = value;
        },
        textBaseline: '',
        fillStyle: '',
        /** @param {string} text */
        measureText(text){
            const inked = text.trim() !== '';
            const code = text.charCodeAt(0) || 0;
            return {
                width: advance(text),
                actualBoundingBoxLeft: inked ? code % 3 : 0,
                actualBoundingBoxRight: inked ? advance(text) + (code % 2) : 0,
                actualBoundingBoxAscent: inked ? Math.round(em() * 0.7) - (code % 4) : 0,
                actualBoundingBoxDescent: inked ? code % 3 : 0,
                fontBoundingBoxAscent: em() * 0.9,
                fontBoundingBoxDescent: em() * 0.25,
            };
        },
        /** @param {number} a @param {number} b @param {number} c @param {number} d
         *  @param {number} e @param {number} f */
        setTransform(a, b, c, d, e, f){
            dx = e;
            dy = f;
        },
        /** @param {number} x @param {number} y @param {number} w @param {number} h */
        clearRect(x, y, w, h){
            for (let row = y; row < y + h; row++)
            {
                for (let column = x; column < x + w; column++)
                {
                    plot(column, row, 0);
                }
            }
        },
        /** @param {number} x @param {number} y @param {number} w @param {number} h */
        fillRect(x, y, w, h){
            for (let row = Math.round(y); row < y + h; row++)
            {
                for (let column = Math.round(x); column < x + w; column++)
                {
                    plot(column, row, 255);
                }
            }
        },
        /** @param {string} text @param {number} x @param {number} y */
        fillText(text, x, y){
            const code = text.charCodeAt(0);
            const box = context.measureText(text);
            const left = Math.round(x + dx - box.actualBoundingBoxLeft);
            const top = Math.round(y + dy - box.actualBoundingBoxAscent);
            const w = Math.ceil(box.actualBoundingBoxLeft + box.actualBoundingBoxRight);
            const h = Math.ceil(box.actualBoundingBoxAscent + box.actualBoundingBoxDescent);
            const mix = salt() ^ Math.imul(code, 2654435761);
            for (let row = 0; row < h; row++)
            {
                for (let column = 0; column < w; column++)
                {
                    const value = (Math.imul(mix ^ (row * 131 + column * 17), 2246822519) >>> 24);
                    plot(left + column, top + row, value < 64 ? 0 : value);
                }
            }
        },
        /** @param {number} x @param {number} y @param {number} w @param {number} h */
        getImageData(x, y, w, h){
            const data = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++)
            {
                const from = ((y + row) * width + x) * 4;
                data.set(pixels.subarray(from, from + w * 4), row * w * 4);
            }
            return { data };
        },
    };
    return (/** @type {number} */ w, /** @type {number} */ h)=>{
        width = w;
        height = h;
        pixels = new Uint8ClampedArray(w * h * 4);
        return { width: w, height: h, getContext: ()=>context };
    };
}

const FACE_NAMES = ['Tahoma', 'Arial', 'MS Sans Serif', 'Courier New', 'Some Unknown Face'];

/**
 * A glyph taken out of its read.
 *
 * @param {import('./fonts.js').Glyph} glyph
 */
const taken = glyph=>[glyph.advance, glyph.left, glyph.top, glyph.width, glyph.height,
    [...glyph.bytes.subarray(glyph.offset, glyph.offset + glyph.width * glyph.height)].join(',')]
    .join(':');

/**
 * One seeded program: everything it observed, in order.
 *
 * @param {number} seed @param {'none' | 'cache' | 'small'} where  pages kept nowhere, in
 *     the run's cache, or in a cache too small for them
 * @param {{ mutate?: boolean }} [options]  `mutate`: the cache's read of a page is wrong in
 *     one byte of coverage, which the gate must see
 */
async function run(seed, where, { mutate = false } = {}){
    const next = random(seed);
    const cache = where === 'none' ? null
        : await testCache(where === 'small' ? { budget: 8 << 10, segmentBytes: 4 << 10 } : {});
    let space = cache ? cache.space('glyphs') : (await testCache({ budget: 0 })).space('glyphs');
    if (cache && mutate)
    {
        const inner = space;
        space = { ...inner, with: (key, read, options)=>inner.with(key, page=>{
            const wrong = page.slice();
            wrong[wrong.length - 1] ^= 0x5a;
            return read(wrong);
        }, options) };
    }
    const engine = createFontEngine({ scratch: testScratch('gdi/glyph-page'),
        canvas: fakeCanvas(), space });
    /** @type {string[]} */
    const seen = [];
    const fonts = Array.from({ length: 3 + next() % 3 }, ()=>({
        faceName: FACE_NAMES[next() % FACE_NAMES.length],
        // Now and then a large face, whose pages outgrow the small cache's segments.
        height: next() % 4 === 0 ? 10 + next() % 20
            : -(8 + next() % (next() % 6 === 0 ? 56 : 24)),
        weight: next() % 3 === 0 ? 700 : 0,
        italic: next() % 5 === 0 ? 1 : 0,
        underline: next() % 6 === 0 ? 1 : 0,
        strikeOut: next() % 7 === 0 ? 1 : 0,
        quality: next() % 4 === 0 ? NONANTIALIASED_QUALITY : 0,
    }));
    for (let line = 0; line < 30; line++)
    {
        const font = fonts[next() % fonts.length];
        // Mostly the program's printable bytes, some of its high ones and
        // now and then a wide code, from a page of its own.
        const text = Array.from({ length: 1 + next() % 24 }, ()=>{
            const pick = next() % 10;
            return String.fromCharCode(pick < 7 ? 0x20 + next() % 0x5f
                : pick < 9 ? 0x80 + next() % 0x80 : 0x400 + next() % (PAGE_CODES * 8));
        }).join('');
        seen.push(JSON.stringify(engine.metrics(font)));
        for (const character of text)
        {
            seen.push(engine.glyph(character.charCodeAt(0), font, taken) ?? 'none');
        }
        const measured = /** @type {import('./fonts.js').FontMetrics} */ (engine.metrics(font));
        const metrics = { cellWidth: measured.aveCharWidth, cellHeight: measured.height,
            ascent: measured.ascent,
            glyphs: (/** @type {number} */ code, /** @type {any} */ read, /** @type {any} */ arg)=>
                engine.glyph(code, font, read, arg) };
        seen.push(`extent ${textExtent(text, metrics)}`);
        const surface = createSurface({ width: 160, height: 48 });
        clearSurface(surface, 0x00203040);
        const clipped = next() % 3 === 0;
        const result = extTextOut(createPainter(surface), {
            x: next() % 40 - 8, y: next() % 16 - 4, text, metrics,
            textColor: next() & 0xffffff, bkColor: next() & 0xffffff,
            bkMode: next() % 2 === 0 ? OPAQUE : TRANSPARENT,
            ...clipped ? { rect: { left: 10, top: 4, right: 120, bottom: 40 }, flags: 4 } : {},
        });
        seen.push(JSON.stringify(result), [...surface.bytes].join(','));
        // Idle long enough for the cache to let pages go: drawn again later.
        const idle = next() % 4 === 0;
        if (cache && idle)
        {
            cache.idle(5000);
        }
    }
    return { seen, figures: /** @type {NonNullable<import('./fonts.js').FontEngine['figures']>} */ (
        engine.figures)() };
}

test('glyphs kept as pages of the run\'s cache answer and draw as glyphs drawn afresh',
    { timeout: 300_000 }, async()=>{
        let put = 0;
        let drawnAgain = 0;
        let refused = 0;
        for (const where of /** @type {const} */ (['cache', 'small']))
        {
            for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
            {
                const plain = await run(seed, 'none');
                const cached = await run(seed, where);
                const at = `${where}, seed ${seed}`;
                assert.equal(cached.seen.length, plain.seen.length, at);
                for (let index = 0; index < plain.seen.length; index++)
                {
                    assert.equal(cached.seen[index], plain.seen[index], `${at}: answer ${index}`);
                }
                assert.equal(plain.figures.pagesPut, 0, at);
                put += cached.figures.pagesPut;
                drawnAgain += plain.figures.drawn - cached.figures.drawn;
                refused += cached.figures.pagesRefused;
            }
        }
        assert.ok(put > 0, 'pages went into the cache');
        assert.ok(drawnAgain > 0, 'pages the cache kept were not drawn again');
        assert.ok(refused > 0, 'pages the cache had no room for were refused, counted');
    });

test('the gate sees a wrong read of a page in the run\'s cache', { timeout: 300_000 }, async()=>{
    let differed = 0;
    for (const seed of [1, 2, 3])
    {
        const plain = await run(seed, 'none');
        const wrong = await run(seed, 'cache', { mutate: true });
        differed += wrong.seen.some((answer, at)=>answer !== plain.seen[at]) ? 1 : 0;
    }
    assert.equal(differed, 3, 'every program reads a page wrong');
});
