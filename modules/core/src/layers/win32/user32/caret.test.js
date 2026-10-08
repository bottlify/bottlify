/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaret } from './caret.js';
import { createMessageQueue } from './messages.js';
import { createWindowFunctions } from './windows.js';
import { decodeAnsi } from '../kernel32/locale.js';

const ERROR_ACCESS_DENIED = 5;
const ERROR_NOACCESS = 998;
const ERROR_INVALID_WINDOW_HANDLE = 1400;
const POINT = 0x100;

/**
 * The caret over a fake window manager: windows by handle, each on a thread,
 * and every inversion written down with the window it was drawn in.
 *
 * @param {{ thread?: { current: unknown } }} [options]
 */
function caretOver({ thread = { current: 'main' } } = {}){
    const memory = new Uint8Array(0x200);
    /** @type {Map<number, { hwnd: number, thread: unknown }>} */
    const windows = new Map([[0x10, { hwnd: 0x10, thread: 'main' }],
        [0x20, { hwnd: 0x20, thread: 'main' }], [0x30, { hwnd: 0x30, thread: 'other' }]]);
    /** @type {{ hwnd: number, rect: any, gray: boolean }[]} */
    const inverted = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    let painted = 0;
    const caret = createCaret({
        live: hwnd=>windows.get(hwnd >>> 0) ?? null,
        caller: ()=>thread.current,
        threadOf: record=>record.thread,
        contextOn: record=>record.hwnd + 1,
        release: ()=>{},
        draw: {
            invert: (hdc, rect, gray = false)=>{
                inverted.push({ hwnd: hdc - 1, rect, gray });
                return true;
            },
        },
        painted: ()=>{
            painted++;
        },
        bitmapSize: handle=>(handle === 0x500 ? { width: 3, height: 9 } : null),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        setLastError: code=>errors.push(code),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    const point = ()=>{
        const view = new DataView(memory.buffer, POINT, 8);
        return [view.getInt32(0, true), view.getInt32(4, true)];
    };
    return { caret, table: /** @type {any} */ (caret.table), windows, inverted, errors, said,
        point, thread,
        painted: ()=>painted };
}

test('a new caret is hidden until shown, and each hide wants a show', ()=>{
    const m = caretOver();
    assert.equal(m.table.CreateCaret.handler([0x10, 0, 2, 12]), 1);
    assert.deepEqual(m.inverted, [], 'created hidden');
    assert.equal(m.table.ShowCaret.handler([0x10]), 1);
    assert.deepEqual(m.inverted, [{ hwnd: 0x10, rect: { left: 0, top: 0, right: 2, bottom: 12 },
        gray: false }]);
    assert.equal(m.painted(), 1, 'the screen is told it changed');

    // Hidden twice, shown twice before it is drawn again.
    m.table.HideCaret.handler([0x10]);
    m.table.HideCaret.handler([0]);
    assert.equal(m.inverted.length, 2, 'taken off once');
    m.table.ShowCaret.handler([0x10]);
    assert.equal(m.inverted.length, 2, 'still one hide outstanding');
    m.table.ShowCaret.handler([0]);
    assert.equal(m.inverted.length, 3);
    // A show of a caret not hidden changes nothing and still succeeds.
    assert.equal(m.table.ShowCaret.handler([0x10]), 1);
    assert.equal(m.inverted.length, 3);
});

test('a caret moves by taking itself off and drawing itself again', ()=>{
    const m = caretOver();
    m.table.CreateCaret.handler([0x10, 0, 0, 0]);
    m.table.ShowCaret.handler([0]);
    assert.deepEqual(m.inverted[0].rect, { left: 0, top: 0, right: 1, bottom: 1 },
        'a size of zero is the window border\'s');
    assert.equal(m.table.SetCaretPos.handler([5, 7]), 1);
    assert.deepEqual(m.inverted.slice(1).map(each=>each.rect), [
        { left: 0, top: 0, right: 1, bottom: 1 }, { left: 5, top: 7, right: 6, bottom: 8 }]);
    assert.equal(m.table.SetCaretPos.handler([5, 7]), 1);
    assert.equal(m.inverted.length, 3, 'the same place is not redrawn');

    // Moved while hidden: nothing drawn, and shown at the new place.
    m.table.HideCaret.handler([0]);
    m.table.SetCaretPos.handler([9, 1]);
    assert.equal(m.inverted.length, 4);
    m.table.ShowCaret.handler([0]);
    assert.deepEqual(m.inverted[4].rect, { left: 9, top: 1, right: 10, bottom: 2 });

    assert.equal(m.table.GetCaretPos.handler([POINT]), 1);
    assert.deepEqual(m.point(), [9, 1]);
    assert.equal(m.table.GetCaretPos.handler([0]), 0);
    assert.deepEqual(m.errors, [ERROR_NOACCESS]);
});

test('only the window holding the caret may hide or show it', ()=>{
    const m = caretOver();
    m.table.CreateCaret.handler([0x10, 0, 1, 1]);
    assert.equal(m.table.ShowCaret.handler([0x20]), 0);
    assert.equal(m.table.HideCaret.handler([0x20]), 0);
    assert.deepEqual(m.errors, [ERROR_ACCESS_DENIED, ERROR_ACCESS_DENIED]);
    assert.deepEqual(m.inverted, []);
});

test('with no caret the calls fail, and the last position is still answered', ()=>{
    const m = caretOver();
    assert.equal(m.table.DestroyCaret.handler([]), 0);
    assert.equal(m.table.ShowCaret.handler([0]), 0);
    assert.equal(m.table.HideCaret.handler([0]), 0);
    assert.equal(m.table.SetCaretPos.handler([1, 1]), 0);

    m.table.CreateCaret.handler([0x10, 0, 1, 1]);
    m.table.SetCaretPos.handler([4, 6]);
    m.table.ShowCaret.handler([0]);
    assert.equal(m.table.DestroyCaret.handler([]), 1);
    assert.equal(m.inverted.length, 2, 'taken off the screen as it goes');
    assert.equal(m.table.GetCaretPos.handler([POINT]), 1);
    assert.deepEqual(m.point(), [4, 6]);
});

test('a new caret replaces the old one, and a window gone takes its caret', ()=>{
    const m = caretOver();
    m.table.CreateCaret.handler([0x10, 0, 1, 4]);
    m.table.ShowCaret.handler([0]);
    assert.equal(m.table.CreateCaret.handler([0x20, 1, 3, 3]), 1);
    assert.deepEqual(m.inverted.map(each=>each.hwnd), [0x10, 0x10], 'the old one taken off');
    m.table.ShowCaret.handler([0x20]);
    assert.deepEqual(m.inverted[2], { hwnd: 0x20, rect: { left: 0, top: 0, right: 3, bottom: 3 },
        gray: true }, '(HBITMAP)1 is the grey caret');

    m.windows.delete(0x20);
    assert.equal(m.table.HideCaret.handler([0]), 0, 'gone with its window');
    assert.equal(m.inverted.length, 3, 'and nothing is drawn into a window that is not there');
});

test('a bitmap caret takes the bitmap\'s size, and says it is drawn as a rectangle', ()=>{
    const m = caretOver();
    m.table.CreateCaret.handler([0x10, 0x500, 40, 40]);
    m.table.ShowCaret.handler([0]);
    assert.deepEqual(m.inverted[0].rect, { left: 0, top: 0, right: 3, bottom: 9 });
    assert.equal(m.said.length, 1);
});

test('the caret is the thread\'s: another thread has its own, and none in another\'s window', ()=>{
    const m = caretOver();
    assert.equal(m.table.CreateCaret.handler([0x30, 0, 1, 1]), 0);
    assert.deepEqual(m.errors, [ERROR_ACCESS_DENIED]);
    assert.equal(m.table.CreateCaret.handler([0x99, 0, 1, 1]), 0);
    assert.deepEqual(m.errors, [ERROR_ACCESS_DENIED, ERROR_INVALID_WINDOW_HANDLE]);

    m.table.CreateCaret.handler([0x10, 0, 1, 1]);
    m.thread.current = 'other';
    assert.equal(m.table.HideCaret.handler([0]), 0, 'the other thread has none');
    assert.equal(m.table.CreateCaret.handler([0x30, 0, 1, 1]), 1);
    m.thread.current = 'main';
    assert.equal(m.table.ShowCaret.handler([0x10]), 1, 'and the first thread\'s is untouched');
});

test('a paint takes the caret off its window and puts it back after', ()=>{
    const m = caretOver();
    m.table.CreateCaret.handler([0x10, 0, 1, 1]);
    m.table.ShowCaret.handler([0]);
    m.caret.paintStarts({ hwnd: 0x20 });
    assert.equal(m.inverted.length, 1, 'another window\'s paint leaves it');
    m.caret.paintStarts({ hwnd: 0x10 });
    assert.equal(m.inverted.length, 2, 'off before the window paints over it');
    // Placed during the paint, drawn once the paint is over.
    m.table.SetCaretPos.handler([3, 3]);
    m.table.ShowCaret.handler([0]);
    assert.equal(m.inverted.length, 2);
    m.caret.paintEnds({ hwnd: 0x10 });
    assert.deepEqual(m.inverted[2].rect, { left: 3, top: 3, right: 4, bottom: 4 });
    m.caret.paintEnds({ hwnd: 0x10 });
    assert.equal(m.inverted.length, 3, 'an end with no start is nothing');
});

test('the window manager takes a window\'s caret off for BeginPaint and back at EndPaint',
    ()=>{
        const bytes = new Uint8Array(0x20000);
        /** @type {string[]} */
        const log = [];
        const handles = new Map();
        let next = 4;
        const fns = /** @type {any} */ (createWindowFunctions({
            readMemory: (a, n)=>bytes.slice(a, a + n),
            writeMemory: (a, d)=>bytes.set(d, a),
            readCString: (a, n)=>{
                let end = a;
                while (bytes[end] !== 0 && end - a < n)
                {
                    end++;
                }
                return decodeAnsi(bytes.subarray(a, end));
            },
            handles: {
                open: (type, object)=>{
                    handles.set(next, object);
                    next += 4;
                    return next - 4;
                },
                close: handle=>handles.delete(handle),
                resolve: handle=>handles.get(handle),
            },
            queue: createMessageQueue(),
            dispatch: ()=>0,
            park: ()=>({ parked: true }),
            idle: ()=>new Promise(()=>{}),
            screen: { width: 640, height: 480, bitsPerPixel: 32 },
            dc: ()=>({ get: ()=>7, release: ()=>{} }),
            draw: /** @type {any} */ ({
                fill: ()=>true,
                fillBackground: ()=>true,
                text: ()=>true,
                measure: ()=>({ width: 8, height: 16, ascent: 12 }),
                clip: ()=>{},
                invert: (/** @type {number} */ hdc, /** @type {any} */ rect)=>{
                    log.push(`invert ${rect.left},${rect.top}`);
                    return true;
                },
            }),
        }));
        const text = (/** @type {number} */ at, /** @type {string} */ value)=>{
            bytes.set(new TextEncoder().encode(`${value}\0`), at);
            return at;
        };
        const hwnd = fns.CreateWindowExA.handler([0, text(0x10000, 'Static'),
            text(0x10100, ''), 0x10000000, 0, 0, 100, 100, 0, 0, 0, 0]);
        assert.notEqual(hwnd, 0);
        assert.equal(fns.CreateCaret.handler([hwnd, 0, 1, 10]), 1);
        fns.SetCaretPos.handler([4, 2]);
        fns.ShowCaret.handler([hwnd]);
        assert.deepEqual(log, ['invert 4,2']);
        const paintStruct = 0x11000;
        fns.InvalidateRect.handler([hwnd, 0, 0]);
        fns.BeginPaint.handler([hwnd, paintStruct]);
        assert.deepEqual(log, ['invert 4,2', 'invert 4,2'], 'off for the paint');
        fns.EndPaint.handler([hwnd, paintStruct]);
        assert.deepEqual(log, ['invert 4,2', 'invert 4,2', 'invert 4,2'], 'and back');

        fns.DestroyWindow.handler([hwnd]);
        assert.equal(fns.DestroyCaret.handler([]), 0, 'gone with the window');
    });
