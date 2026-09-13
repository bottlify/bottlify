/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFontEngine, familyOf } from './fonts.js';
import { extTextOut, textExtent } from './text.js';
import { createGdiDrawing } from './context.js';
import { TRANSPARENT } from './brush.js';
import { createPainter } from './shapes.js';
import { clearSurface, colorToPixel, createSurface } from './surface.js';

/**
 * A 2D context that behaves like a font: every character is half an em
 * wide, the face's box is 0.9 em up and 0.25 em down, and a letter is
 * painted as a solid box seven rows tall whose first column is half
 * covered -- so the composite has a fully inked pixel and a mixed one to
 * be checked against.
 */
function fakeCanvas(){
    const calls = { fillText: 0, measureText: 0 };
    let width = 0;
    let height = 0;
    /** @type {Uint8ClampedArray} */
    let pixels = new Uint8ClampedArray(0);
    /** @type {string} */
    let font = '';
    const em = ()=>Number(/(\d+)px/.exec(font)?.[1] ?? 0);
    /** @param {string} text */
    const advance = text=>text.length * em() / 2;
    /** @param {number} x @param {number} y @param {number} w @param {number} h @param {number} alpha */
    const paint = (x, y, w, h, alpha)=>{
        for (let row = Math.max(0, y); row < Math.min(height, y + h); row++)
        {
            for (let column = Math.max(0, x); column < Math.min(width, x + w); column++)
            {
                pixels[(row * width + column) * 4 + 3] = alpha;
            }
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
            calls.measureText++;
            const inked = text.trim() !== '';
            return {
                width: advance(text),
                actualBoundingBoxLeft: 0,
                actualBoundingBoxRight: inked ? advance(text) : 0,
                actualBoundingBoxAscent: inked ? 7 : 0,
                actualBoundingBoxDescent: 0,
                fontBoundingBoxAscent: em() * 0.9,
                fontBoundingBoxDescent: em() * 0.25,
            };
        },
        /** @param {number} x @param {number} y @param {number} w @param {number} h */
        clearRect(x, y, w, h){
            paint(x, y, w, h, 0);
        },
        /** @param {number} x @param {number} y @param {number} w @param {number} h */
        fillRect(x, y, w, h){
            paint(x, y, w, h, 255);
        },
        /** @param {string} text @param {number} x @param {number} y */
        fillText(text, x, y){
            calls.fillText++;
            if (text.trim() !== '')
            {
                paint(x, y - 7, advance(text), 7, 255);
                paint(x, y - 7, 1, 7, 128);
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
    return {
        calls,
        context,
        /** @param {number} w @param {number} h */
        canvas: (w, h)=>{
            width = w;
            height = h;
            pixels = new Uint8ClampedArray(w * h * 4);
            return { width: w, height: h, getContext: ()=>context };
        },
    };
}

/** @param {Partial<import('./fonts.js').FontRequest>} fields */
const font = fields=>({
    height: -10, weight: 0, italic: 0, underline: 0, strikeOut: 0, faceName: 'Tahoma', ...fields,
});

test('without a canvas the engine says so and answers nothing', ()=>{
    const engine = createFontEngine({});
    assert.equal(engine.available, false);
    assert.equal(engine.metrics(font({})), null);
    assert.equal(engine.glyph(0x41, font({})), null);
});

test('a face name maps to a family stack with a generic family behind it', ()=>{
    assert.equal(familyOf('Tahoma'), '"Tahoma", sans-serif');
    assert.equal(familyOf('MS Sans Serif'), '"MS Sans Serif", sans-serif');
    assert.equal(familyOf('Times New Roman'), '"Times New Roman", serif');
    assert.equal(familyOf('Courier New'), '"Courier New", monospace');
    assert.equal(familyOf('Fixedsys'), '"Fixedsys", monospace');
    assert.equal(familyOf('Some Unknown Face'), '"Some Unknown Face", sans-serif');
    assert.equal(familyOf(''), 'sans-serif');
});

test('a negative height is the character height and a positive one the cell', ()=>{
    const engine = createFontEngine({ canvas: fakeCanvas().canvas });
    const character = engine.metrics(font({ height: -10 }));
    assert.deepEqual(character, {
        height: 12, ascent: 9, descent: 3, internalLeading: 2, externalLeading: 0,
        aveCharWidth: 5, maxCharWidth: 5,
    });
    // A cell of 16 at 1.15 cell per em is a 13-pixel em: 12 up, 4 down.
    const cell = engine.metrics(font({ height: 16 }));
    assert.equal(cell?.height, 16);
    assert.equal(cell?.ascent, 12);
    assert.equal(cell?.internalLeading, 3);
});

test('a glyph is the canvas coverage, placed against the pen and the cell top', ()=>{
    const fake = fakeCanvas();
    const engine = createFontEngine({ canvas: fake.canvas });
    const glyph = engine.glyph(0x41, font({ height: -10 }));
    assert.ok(glyph);
    assert.equal(glyph.advance, 5);
    assert.equal(glyph.left, 0);
    assert.equal(glyph.top, 9 - 7, 'the glyph box sits on the baseline');
    assert.equal(glyph.width, 5);
    assert.equal(glyph.height, 7);
    assert.equal(glyph.coverage[0], 128);
    assert.equal(glyph.coverage[1], 255);
    assert.equal(glyph.coverage.length, 35);

    const space = engine.glyph(0x20, font({ height: -10 }));
    assert.equal(space?.advance, 5);
    assert.equal(space?.width, 0, 'a space covers nothing but still advances');
});

test('a glyph is rasterised once per font and served from the cache after', ()=>{
    const fake = fakeCanvas();
    const engine = createFontEngine({ canvas: fake.canvas });
    const first = engine.glyph(0x41, font({}));
    const again = engine.glyph(0x41, font({}));
    assert.equal(again, first);
    assert.equal(fake.calls.fillText, 1);
    engine.glyph(0x41, font({ weight: 700 }));
    assert.equal(fake.calls.fillText, 2, 'a different weight is a different glyph');
    engine.glyph(0x41, font({ faceName: 'Arial' }));
    assert.equal(fake.calls.fillText, 3, 'a different face is a different glyph');
});

test('the program\'s bytes are drawn as Windows-1252', ()=>{
    const fake = fakeCanvas();
    const engine = createFontEngine({ canvas: fake.canvas });
    let drawn = '';
    const original = fake.context.fillText;
    fake.context.fillText = (text, x, y)=>{
        drawn = text;
        original(text, x, y);
    };
    engine.glyph(0x80, font({}));
    assert.equal(drawn, '€', 'byte 0x80 is the euro sign, not a control');
});

const BACKGROUND = 0x00303030;
const INK_COLOR = 0x000000ff;
const INK = colorToPixel(INK_COLOR);

test('text is composited from the glyph coverage in the text colour', ()=>{
    const engine = createFontEngine({ canvas: fakeCanvas().canvas });
    const request = font({ height: -10 });
    const measured = engine.metrics(request);
    assert.ok(measured);
    const metrics = {
        cellWidth: measured.aveCharWidth, cellHeight: measured.height, ascent: measured.ascent,
        glyphs: (/** @type {number} */ code)=>engine.glyph(code, request),
    };
    assert.equal(textExtent('AB', metrics), 10, 'the extent is the sum of the advances');
    assert.equal(textExtent('AB', metrics, [7, 7]), 14, 'unless the program supplied them');

    const surface = createSurface({ width: 20, height: 14 });
    clearSurface(surface, BACKGROUND);
    const result = extTextOut(createPainter(surface), {
        x: 2, y: 1, text: 'AB', metrics, textColor: INK_COLOR, bkColor: 0, bkMode: TRANSPARENT,
    });
    assert.equal(result.width, 10);
    // The glyph box is rows 2..8 of the cell: fully inked pixels are the
    // pure text colour, the half-covered column is mixed with the ground.
    assert.equal(surface.read(3, 3), INK);
    assert.equal(surface.read(3, 9), INK);
    assert.equal(surface.read(3, 2), BACKGROUND, 'above the glyph box');
    assert.equal(surface.read(3, 10), BACKGROUND, 'below the baseline');
    assert.equal(surface.read(8, 3), INK, 'the second glyph at its advance');
    const mixed = surface.read(2, 3);
    assert.equal((mixed >>> 16) & 0xff, Math.round((0xff * 128 + 0x30 * 127) / 255), 'red: ink');
    assert.equal(mixed & 0xff, Math.round((0x30 * 127) / 255), 'blue: the ground, faded');
    assert.equal(surface.read(12, 3), BACKGROUND, 'nothing past the run');
});

test('a drawing with an engine that has no canvas draws exactly as one without', ()=>{
    /** @param {import('./fonts.js').FontEngine | undefined} fonts */
    const paint = fonts=>{
        const surface = createSurface({ width: 40, height: 16 });
        clearSurface(surface, BACKGROUND);
        const drawing = createGdiDrawing({ fonts });
        drawing.bind(1, surface);
        drawing.textOutA(1, 0, 0, 'Hi');
        return surface.bytes.slice();
    };
    assert.deepEqual(paint(createFontEngine({})), paint(undefined));
});

test('a drawing with an engine draws its glyphs for the selected font', ()=>{
    const fake = fakeCanvas();
    const engine = createFontEngine({ canvas: fake.canvas });
    /** @type {import('./context.js').GdiObjectTable} */
    const objects = {
        get: handle=>(handle === 7
            ? { handle, type: 'font', attributes: font({ height: -10 }), selectCount: 0,
                stock: false }
            : null),
    };
    const surface = createSurface({ width: 40, height: 16 });
    clearSurface(surface, BACKGROUND);
    const drawing = createGdiDrawing({ objects, fonts: engine });
    drawing.bind(1, surface, { font: 7, textColor: INK_COLOR, bkColor: 0, bkMode: TRANSPARENT,
        position: { x: 0, y: 0 } });
    assert.deepEqual(drawing.textExtent(1, 'AB'), { cx: 10, cy: 16 },
        'the width is the glyph advances; the height the injected cell');
    drawing.textOutA(1, 0, 0, 'AB');
    assert.equal(fake.calls.fillText, 2);
    assert.equal(surface.read(1, 5), INK);
});
