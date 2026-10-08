/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMCTL32_ORDINALS, createComctlFunctions } from './functions.js';
import { createHelperFunctions } from './helpers.js';
import { TB_ADDBITMAP, TB_ADDBUTTONSA, TB_BUTTONSTRUCTSIZE, TB_SETBITMAPSIZE,
    TB_SETBUTTONSIZE } from './toolbar.js';

/**
 * Guest memory, a bump allocator, and user32 and gdi32 stand-ins that record
 * what they were asked and answer from the tables given.
 *
 * @param {Record<string, (args: number[]) => any>} user32
 * @param {Record<string, (args: number[]) => any>} [gdi32]
 */
function machine(user32, gdi32){
    const bytes = new Uint8Array(0x20000);
    const view = new DataView(bytes.buffer);
    let next = 0x10000;
    /** @type {number[]} */
    const released = [];
    /** @type {string[]} */
    const diverged = [];
    /** @type {[string, number[]][]} */
    const calls = [];
    /** @param {Record<string, (args: number[]) => any>} table @param {string} name */
    const lookup = (table, name)=>(table[name] ? { handler: (/** @type {number[]} */ args)=>{
        calls.push([name, args]);
        return table[name](args);
    } } : undefined);
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
            bytes.set(data, at),
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        release: (/** @type {number} */ at)=>{
            released.push(at);
        },
        user32: (/** @type {string} */ name)=>lookup(user32, name),
        gdi32: gdi32 ? (/** @type {string} */ name)=>lookup(gdi32, name) : undefined,
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>{
            diverged.push(`${api}: ${detail}`);
        },
        now: ()=>1000,
    };
    const made = /** @type {unknown} */ (createHelperFunctions(host));
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (made);
    /** @param {number} at */
    const ascii = at=>String.fromCharCode(...bytes.subarray(at, bytes.indexOf(0, at)));
    return { bytes, view, fns, calls, released, diverged, ascii, host };
}

test('CreateToolbarEx makes the toolbar and tells it its sizes, bitmap and buttons', ()=>{
    /** @type {[number, number, number][]} */
    const sent = [];
    let className = '';
    /** @type {any} */
    let m = null;
    m = machine({
        CreateWindowExA: args=>{
            className = m.ascii(args[1]);
            return 0x1234;
        },
        SendMessageA: ([, message, wParam, lParam])=>{
            sent.push([message, wParam, lParam]);
            if (message === TB_ADDBITMAP)
            {
                assert.deepEqual([m.view.getUint32(lParam, true), m.view.getUint32(lParam + 4,
                    true)], [0x400000, 0x65], 'the TBADDBITMAP the call was given');
            }
            return 1;
        },
    });
    const hwnd = m.fns.CreateToolbarEx.handler([0x100, 0x50000000, 7, 4, 0x400000, 0x65,
        0x8000, 3, 24, 22, 16, 15, 20]);
    assert.equal(hwnd, 0x1234);
    assert.equal(className, 'ToolbarWindow32');
    const calls = /** @type {[string, number[]][]} */ (m.calls);
    const create = calls.find(([name])=>name === 'CreateWindowExA')?.[1] ?? [];
    assert.equal(create[3] & 0x40000000, 0x40000000, 'a child');
    assert.deepEqual([create[8], create[9]], [0x100, 7], 'of the window, with the id');
    assert.deepEqual(sent.map(([message, wParam])=>[message, wParam]), [
        [TB_BUTTONSTRUCTSIZE, 20], [TB_SETBITMAPSIZE, 0], [TB_SETBUTTONSIZE, 0],
        [TB_ADDBITMAP, 4], [TB_ADDBUTTONSA, 3]]);
    assert.equal(sent[1][2], 15 << 16 | 16);
    assert.equal(sent[2][2], 22 << 16 | 24);
    assert.equal(sent[4][2], 0x8000);
    assert.equal(m.released.length, 1, 'the scratch memory given back');

    sent.length = 0;
    m.fns.CreateToolbarEx.handler([0x100, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20]);
    assert.deepEqual(sent.map(([message])=>message), [TB_BUTTONSTRUCTSIZE],
        'nothing else when nothing else was given');
    assert.equal(m.fns.CreateToolbarEx.argBytes, 52);
});

test('CreateToolbarEx answers NULL when the window could not be made', async()=>{
    const m = machine({ CreateWindowExA: ()=>Promise.resolve(0), SendMessageA: ()=>1 });
    assert.equal(await m.fns.CreateToolbarEx.handler([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20]),
        0);
    assert.equal(m.calls.filter(([name])=>name === 'SendMessageA').length, 0);
});

test('CreateMappedBitmap maps the button colours to the system\'s, or the caller\'s map', ()=>{
    const BITMAP = 0x500;
    /** @type {any} */
    let m = null;
    let pixels = new Uint8Array(0);
    const fresh = ()=>{
        // Four 32-bit pixels: black, grey, silver, white -- and one other.
        pixels = Uint8Array.from([0, 0, 0, 0, 0x80, 0x80, 0x80, 0, 0xc0, 0xc0, 0xc0, 0,
            0xff, 0xff, 0xff, 0, 0x10, 0x20, 0x30, 0]);
    };
    m = machine({
        LoadImageA: ()=>{
            fresh();
            return BITMAP;
        },
        GetSysColor: ([index])=>0x010000 * index + 1,
    }, {
        GetObjectA: ([, , out])=>{
            m.view.setInt32(out + 4, 5, true);
            m.view.setInt32(out + 8, 1, true);
            m.view.setInt32(out + 12, 20, true);
            m.view.setUint16(out + 18, 32, true);
            return 24;
        },
        GetBitmapBits: ([, size, out])=>{
            m.bytes.set(pixels.subarray(0, size), out);
            return size;
        },
        SetBitmapBits: ([, size, from])=>{
            pixels = m.bytes.slice(from, from + size);
            return size;
        },
    });
    assert.equal(m.fns.CreateMappedBitmap.handler([0x400000, 0x65, 0, 0, 0]), BITMAP);
    /** @param {number} at */
    const rgb = at=>pixels[at * 4 + 2] | pixels[at * 4 + 1] << 8 | pixels[at * 4] << 16;
    assert.deepEqual([0, 1, 2, 3, 4].map(rgb), [0x120001, 0x100001, 0x0f0001, 0x140001,
        0x102030], 'button text, shadow, face and highlight; the rest left');

    const map = 0x800;
    m.view.setUint32(map, 0x102030, true);
    m.view.setUint32(map + 4, 0x0000ff, true);
    m.fns.CreateMappedBitmap.handler([0x400000, 0x65, 0, map, 1]);
    assert.deepEqual([0, 4].map(rgb), [0x000000, 0x0000ff], 'only what the map names');
    assert.equal(m.fns.CreateMappedBitmap.argBytes, 20);
});

test('CreateMappedBitmap answers NULL for no resource, and without gdi32 says so', ()=>{
    const m = machine({ LoadImageA: ()=>0 });
    assert.equal(m.fns.CreateMappedBitmap.handler([0x400000, 0x65, 0, 0, 0]), 0);
    const plain = machine({ LoadImageA: ()=>0x500, GetSysColor: ()=>0 });
    assert.equal(plain.fns.CreateMappedBitmap.handler([0x400000, 0x65, 0, 0, 0]), 0x500);
    assert.equal(plain.diverged.length, 1);
});

test('LBItemFromPt finds the item under a screen point, and scrolls past the edges', ()=>{
    /** @type {number[]} */
    const tops = [];
    let top = 2;
    /** @type {any} */
    let m = null;
    m = machine({
        // The list box sits at (100, 50) on the screen, 80 by 40, items 10 high.
        ScreenToClient: ([, point])=>{
            m.view.setInt32(point, m.view.getInt32(point, true) - 100, true);
            m.view.setInt32(point + 4, m.view.getInt32(point + 4, true) - 50, true);
            return 1;
        },
        GetClientRect: ([, rect])=>{
            [0, 0, 80, 40].forEach((value, at)=>m.view.setInt32(rect + at * 4, value, true));
            return 1;
        },
        SendMessageA: ([, message, wParam, lParam])=>{
            switch (message){
                case 0x018b: return 10;
                case 0x018e: return top;
                case 0x0197:
                    tops.push(wParam);
                    return 0;
                case 0x0198:
                    [0, (wParam - top) * 10, 80, (wParam - top + 1) * 10]
                        .forEach((value, at)=>m.view.setInt32(lParam + at * 4, value, true));
                    return 1;
                default: return 0;
            }
        },
    });
    assert.equal(m.fns.LBItemFromPt.handler([0x300, 110, 55, 0]), 2, 'the top item');
    assert.equal(m.fns.LBItemFromPt.handler([0x300, 110, 75, 0]), 4);
    assert.equal(m.fns.LBItemFromPt.handler([0x300, 50, 75, 0]), -1, 'beside the list');
    assert.equal(m.fns.LBItemFromPt.handler([0x300, 110, 40, 0]), -1, 'above, not scrolling');
    assert.deepEqual(tops, []);
    assert.equal(m.fns.LBItemFromPt.handler([0x300, 110, 40, 1]) | 0, -1, 'above');
    assert.deepEqual(tops, [1], 'scrolled up one');
    top = 1;
    assert.equal(m.fns.LBItemFromPt.handler([0x300, 110, 95, 1]) | 0, -1);
    assert.deepEqual(tops, [1], 'not again within the interval');
    assert.equal(m.fns.LBItemFromPt.argBytes, 16, 'the POINT is passed by value');
});

test('MakeDragList is refused, and the ordinals are the 5.82 library\'s', ()=>{
    const m = machine({});
    assert.equal(m.fns.MakeDragList.handler([0x300]), 0);
    assert.equal(m.diverged.length, 1);
    assert.equal(m.fns.MakeDragList.argBytes, 4);
    // Wine's comctl32.spec, from the 5.81 library, and 5.82 alike.
    assert.deepEqual(COMCTL32_ORDINALS, { 8: 'CreateMappedBitmap', 13: 'MakeDragList',
        14: 'LBItemFromPt', 17: 'InitCommonControls' });
    const all = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (
        createComctlFunctions(/** @type {any} */ ({ ...m.host }))));
    for (const name of Object.values(COMCTL32_ORDINALS))
    {
        assert.ok(all[name], `${name} is exported`);
    }
    assert.equal(all.PropertySheet, all.PropertySheetA, 'the bare name is the ANSI one');
    assert.equal(all.ImageList_LoadImage, all.ImageList_LoadImageA);
    assert.equal(all.CreatePropertySheetPage, all.CreatePropertySheetPageA);
});
