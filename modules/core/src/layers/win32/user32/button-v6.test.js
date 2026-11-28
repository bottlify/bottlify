/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BCM_GETIDEALSIZE, BCM_GETIMAGELIST, BCM_GETNOTE, BCM_GETNOTELENGTH, BCM_GETSPLITINFO,
    BCM_GETTEXTMARGIN, BCM_SETIMAGELIST, BCM_SETNOTE, BCM_SETSPLITINFO, BCM_SETTEXTMARGIN,
    BS_COMMANDLINK, BS_SPLITBUTTON, createButtonV6,
} from './button-v6.js';
import { guestOver } from '../common/guest.fixture.js';

const IN = 0x100;
const OUT = 0x200;

/**
 * A machine of 1 KiB, an image list 0x700 of 42x33 images, text 8 a character, 16 a line.
 *
 * @param {4 | 8} [pointerSize]
 */
function machine(pointerSize = 4){
    const memory = new Uint8Array(0x400);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const errors = [];
    const v6 = createButtonV6({
        guest: guestOver(memory, pointerSize),
        imageListSize: himl=>(himl === 0x700 ? { cx: 42, cy: 33 } : null),
        imageSize: image=>(image === 0x800 ? { width: 48, height: 48 } : null),
        textExtent: (_record, text)=>({ width: text.length * 8,
            height: text.split('\n').length * 16 }),
        clientSize: ()=>({ width: 400, height: 200 }),
        setLastError: code=>errors.push(code),
    });
    /** @param {number} style @param {string} [title] @param {number} [version] */
    const button = (style, title = 'WWWW', version = 6)=>{
        const record = { style, title, controlsVersion: version };
        /** @type {{ image?: { type: number, handle: number } }} */
        const state = {};
        /** @param {number} message @param {number} [wParam] @param {number} [lParam] */
        const send = (message, wParam = 0, lParam = 0)=>v6.answer(record, state,
            { message, wParam, lParam });
        return { record, state, send };
    };
    return { memory, view, button, errors };
}

test('user32\'s button, version 5, has none of these messages', ()=>{
    const m = machine();
    assert.equal(m.button(0, 'WWWW', 5).send(BCM_GETIDEALSIZE, 0, OUT), undefined);
});

test('the split part: its glyph, style and size, set by mask and read back by mask', ()=>{
    // Wine's button test, test_bcm_splitinfo.
    const m = machine();
    const b = m.button(0);
    const split = (/** @type {number} */ mask, glyph = 0, style = 0, cx = 0, cy = 0)=>{
        m.memory.fill(0xcc, IN, IN + 20);
        [mask, glyph, style, cx, cy].forEach((value, index)=>m.view.setInt32(IN + index * 4,
            value, true));
        return b.send(BCM_SETSPLITINFO, 0, IN);
    };
    const read = ()=>{
        m.memory.fill(0xcc, OUT, OUT + 20);
        m.view.setUint32(OUT, 0xf, true);
        assert.equal(b.send(BCM_GETSPLITINFO, 0, OUT), 1);
        return [4, 8, 12, 16].map(at=>m.view.getInt32(OUT + at, true));
    };
    assert.equal(b.send(BCM_GETSPLITINFO, 0, 0), 0);
    assert.equal(b.send(BCM_SETSPLITINFO, 0, 0), 1);
    assert.deepEqual(read(), [0x36, 2, 13, 0], 'Marlett\'s arrow, stretched, a check mark wide');
    split(8, 0, 0, 20, -4);
    assert.deepEqual(read(), [0x36, 2, 20, -4]);
    split(8, 0, 0, 0, 11);
    assert.deepEqual(read(), [0x36, 2, 13, 11], 'no width is the default, the height kept');
    split(1, 0x35);
    assert.deepEqual(read(), [0x35, 2, 13, 0], 'a new glyph sizes the part again');
    split(2, 0x700);
    assert.deepEqual(read(), [0x700, 0xa, 42 + 4, 0], 'a list: BCSS_IMAGE, its width and border');
    split(1 | 2, 0x37);
    assert.deepEqual(read(), [0x37, 2, 13, 0], 'a glyph wins over a list');
    split(1 | 4, 0x37, 8);
    assert.deepEqual(read(), [0x37, 8, 4, 0], 'BCSS_IMAGE over a glyph: no image, the border');
});

test('the image list and the text margin are kept as given; a null pointer is refused', ()=>{
    for (const pointerSize of /** @type {const} */ ([4, 8]))
    {
        const m = machine(pointerSize);
        const b = m.button(0);
        const size = pointerSize === 8 ? 32 : 24;
        m.view.setUint32(IN, 0x700, true);
        [1, 2, 3, 4].forEach((value, index)=>m.view.setInt32(IN + pointerSize + index * 4, value,
            true));
        m.view.setUint32(IN + pointerSize + 16, 4, true);
        assert.equal(b.send(BCM_SETIMAGELIST, 0, IN), 1);
        assert.equal(b.send(BCM_SETIMAGELIST, 0, 0), 0);
        assert.equal(b.send(BCM_GETIMAGELIST, 0, OUT), 1);
        assert.deepEqual([...m.memory.subarray(OUT, OUT + size)],
            [...m.memory.subarray(IN, IN + size)], `${pointerSize * 8}-bit BUTTON_IMAGELIST`);
        assert.equal(b.send(BCM_GETIMAGELIST, 0, 0), 0);

        assert.equal(b.send(BCM_SETTEXTMARGIN, 0, IN + 0x40), 1);
        assert.equal(b.send(BCM_GETTEXTMARGIN, 0, OUT + 0x40), 1);
        assert.equal(b.send(BCM_SETTEXTMARGIN, 0, 0), 0);
        assert.equal(b.send(BCM_GETTEXTMARGIN, 0, 0), 0);
    }
});

test('the ideal size holds the text and the image as the alignment places them', ()=>{
    // Wine's test_bcm_get_ideal_size: lower bounds, by kind and alignment.
    const m = machine();
    const ideal = (/** @type {any} */ b)=>{
        m.view.setBigInt64(OUT, 0n, true);
        assert.equal(b.send(BCM_GETIDEALSIZE, 0, OUT), 1);
        return [m.view.getInt32(OUT, true), m.view.getInt32(OUT + 4, true)];
    };
    const text = 32;
    const push = m.button(0);
    push.state.image = { type: 0, handle: 0x800 };
    const [cx, cy] = ideal(push);
    assert.ok(cx >= 48 + text && cy >= 48 && cy < 500, 'a push button: the bitmap beside the text');

    const stacked = m.button(0x0300 | 0x0400);
    stacked.state.image = { type: 0, handle: 0x800 };
    const [sx, sy] = ideal(stacked);
    assert.ok(sx >= 48 && sy >= 48 + 16, 'centred at the top: the image above the text');

    // At the top alone the image goes above too; left at the top keeps it beside.
    for (const [style, above] of /** @type {[number, boolean][]} */ ([[0x0400, true], [0x0800, true], [0x0100 | 0x0400, false]]))
    {
        const b = m.button(style);
        b.state.image = { type: 0, handle: 0x800 };
        const [w, h] = ideal(b);
        assert.ok(above ? h >= 48 + 16 && w < 48 + text : w >= 48 + text,
            `style ${style.toString(16)}`);
    }

    const split = m.button(BS_SPLITBUTTON);
    m.view.setUint32(IN, 8, true);
    m.view.setInt32(IN + 12, 123, true);
    m.view.setInt32(IN + 16, 500, true);
    split.send(BCM_SETSPLITINFO, 0, IN);
    const [px, py] = ideal(split);
    assert.ok(px >= text + 2 * 123 + 2 && py < 500, 'the split part beside, not its height');

    assert.deepEqual(ideal(m.button(0, '')), [400, 200], 'nothing to hold: the size it has');
    assert.deepEqual(ideal(m.button(5)), [400, 200], 'a three-state box is not sized');
    const box = m.button(3);
    box.state.image = { type: 0, handle: 0x800 };
    const [bx, by] = ideal(box);
    assert.ok(bx >= text && bx <= 48 + text && by >= 16 && by <= 48,
        'a check box without BS_BITMAP does not show the image');
    assert.equal(m.button(0, 'WWWW').send(BCM_GETIDEALSIZE, 0, 0), 0);

    const link = m.button(BS_COMMANDLINK, '');
    const [lx, ly] = ideal(link);
    assert.ok(lx === 0 && ly > 0, 'a command link asked with no width keeps none');
});

test('a command link keeps a note; another button refuses one', ()=>{
    const m = machine();
    const link = m.button(BS_COMMANDLINK);
    [...'note\0'].forEach((unit, index)=>m.view.setUint16(IN + index * 2, unit.charCodeAt(0),
        true));
    assert.equal(m.button(0).send(BCM_SETNOTE, 0, IN), 0);
    assert.equal(m.button(0).send(BCM_GETNOTE, OUT, OUT + 8), 0);
    m.errors.splice(0, 1);
    m.view.setUint32(OUT, 10, true);
    assert.equal(link.send(BCM_GETNOTE, OUT, OUT + 8), 0, 'no note set yet');
    assert.deepEqual(m.errors.splice(0), [50, 87], 'not supported elsewhere; invalid here');
    assert.equal(link.send(BCM_SETNOTE, 0, IN), 1);
    assert.equal(link.send(BCM_GETNOTELENGTH), 4);
    /** @param {number} length */
    const wide = length=>String.fromCharCode(...Array.from({ length },
        (_, at)=>m.view.getUint16(OUT + 8 + at * 2, true)));
    m.view.setUint32(OUT, 4, true);
    assert.equal(link.send(BCM_GETNOTE, OUT, OUT + 8), 0, 'too small');
    assert.equal(wide(4), 'not\0', 'what fits, terminated');
    assert.equal(m.view.getUint32(OUT, true), 5, 'and told how much is needed');
    assert.equal(link.send(BCM_GETNOTE, OUT, OUT + 8), 1);
    assert.equal(wide(4), 'note');
    assert.equal(link.send(BCM_SETNOTE, 0, 0), 1, 'a null note empties it');
    assert.equal(link.send(BCM_GETNOTELENGTH), 0);
    m.view.setUint32(OUT, 0, true);
    assert.equal(link.send(BCM_GETNOTE, OUT, OUT + 8), 0);
    assert.equal(m.view.getUint32(OUT, true), 1, 'no room: the terminator\'s');
    assert.deepEqual(m.errors.slice(-1), [122]);
});
