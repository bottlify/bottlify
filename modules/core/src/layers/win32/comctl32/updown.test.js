/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_WIDTH, UDM_GETACCEL, UDM_GETBASE, UDM_GETBUDDY, UDM_GETPOS, UDM_GETPOS32,
    UDM_GETRANGE, UDM_GETRANGE32, UDM_GETUNICODEFORMAT, UDM_SETACCEL, UDM_SETBASE,
    UDM_SETBUDDY, UDM_SETPOS, UDM_SETPOS32, UDM_SETRANGE, UDM_SETRANGE32,
    UDM_SETUNICODEFORMAT, UDN_DELTAPOS, UDS_ALIGNRIGHT, UDS_ARROWKEYS, UDS_HORZ,
    UDS_SETBUDDYINT, createUpDownProcedure, formatPosition, parsePosition,
} from './updown.js';

const WM_CREATE = 0x0001;
const WM_SETTEXT = 0x000c;
const WM_GETTEXT = 0x000d;
const WM_KEYDOWN = 0x0100;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_NOTIFY = 0x004e;
const WM_VSCROLL = 0x0115;
const WM_HSCROLL = 0x0114;
const WM_NOTIFYFORMAT = 0x0055;
const VK_UP = 0x26;
const SB_THUMBPOSITION = 4;
const SB_ENDSCROLL = 8;
const EVENT_OBJECT_VALUECHANGE = 0x800e;
const OBJID_CLIENT = -4;
const PARENT = 0x100;
const EDIT = 0x104;
const UPDOWN = 0x108;
/** MAKELONG(lo, hi). @param {number} lo @param {number} hi */
const long = (lo, hi)=>((hi & 0xffff) << 16 | lo & 0xffff) >>> 0;

/**
 * An up-down control on a parent, beside an edit whose text is kept here,
 * with the host a control is given reduced to what this one uses.
 *
 * @param {{ style?: number, refuse?: boolean, subclass?: boolean }} [options]
 */
function setup({ style = 0, refuse = false, subclass = false } = {}){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let heap = 0x1000;
    /** What the parent was sent: [message, wParam, lParam, notify code]. @type {number[][]} */
    const parent = [];
    /** What the edit was sent. @type {number[]} */
    const edit = [];
    /** @type {number[][]} */
    const events = [];
    /** Subclasses installed on the edit, by [proc, id, data]. @type {number[][]} */
    const hooked = [];
    let editText = '';
    let focus = 0;
    let capture = 0;
    /** @type {Record<number, any>} */
    const records = {
        [PARENT]: { hwnd: PARENT, parent: 0, x: 0, y: 0, width: 300, height: 200, style: 0 },
        [EDIT]: { hwnd: EDIT, parent: PARENT, x: 0, y: 0, width: 100, height: 30,
            className: 'Edit', exStyle: 0, style: 0 },
        [UPDOWN]: { hwnd: UPDOWN, parent: PARENT, id: 1, x: 0, y: 0, width: 300, height: 30,
            className: 'msctls_updown32', style: (0x40000000 | style) >>> 0 },
    };
    /** @param {number} at */
    const readCString = at=>String.fromCharCode(...memory.subarray(at, memory.indexOf(0, at)));
    const host = /** @type {any} */ ({
        live: (/** @type {number} */ hwnd)=>records[hwnd] ?? null,
        children: ()=>[records[EDIT], records[UPDOWN]],
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        readCString,
        allocate: (/** @type {number} */ bytes)=>(heap += (bytes + 15) & ~15) - ((bytes + 15) & ~15),
        release: ()=>{},
        invalidate: ()=>{},
        setFocus: (/** @type {number} */ hwnd)=>{
            focus = hwnd;
            return 0;
        },
        setCapture: (/** @type {number} */ hwnd)=>{
            capture = hwnd;
        },
        capture: ()=>capture,
        releaseCapture: ()=>{
            capture = 0;
        },
        move,
        winEvent,
        send: sendTo,
    });
    /**
     * @param {number} hwnd @param {number} x @param {number} y @param {number} width
     * @param {number} height
     */
    function move(hwnd, x, y, width, height){
        Object.assign(records[hwnd], { x, y, width, height });
        return 1;
    }
    /** @param {number} event @param {number} hwnd @param {number} object @param {number} child */
    function winEvent(event, hwnd, object, child){
        events.push([event, hwnd, object, child]);
        return 0;
    }
    /**
     * @param {number} hwnd @param {number} message @param {number} wParam
     * @param {number} lParam
     */
    function sendTo(hwnd, message, wParam, lParam){
        if (hwnd === EDIT)
        {
            edit.push(message);
            if (message === WM_GETTEXT)
            {
                memory.set([...editText].map(c=>c.charCodeAt(0)).concat(0), lParam);
                return editText.length;
            }
            if (message === WM_SETTEXT)
            {
                editText = readCString(lParam);
            }
            return 1;
        }
        const code = message === WM_NOTIFY ? view.getInt32(lParam + 8, true) : 0;
        parent.push([message, wParam, lParam, code]);
        if (message === WM_NOTIFY && code === UDN_DELTAPOS)
        {
            return refuse ? 1 : 0;
        }
        return 0;
    }
    const tk = {
        stateOf: (/** @type {any} */ record)=>(record.control ??= {}),
        common: ()=>0,
        painting: ()=>0,
        clientRect: (/** @type {any} */ record)=>({ left: 0, top: 0, right: record.width,
            bottom: record.height }),
        contains: (/** @type {any} */ r, /** @type {number} */ x, /** @type {number} */ y)=>
            x >= r.left && x < r.right && y >= r.top && y < r.bottom,
        writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>
            view.setUint32(at, value >>> 0, true),
    };
    const procedure = createUpDownProcedure(host, tk, subclass ? {
        procedure: ()=>0x7f00,
        call: (name, args)=>{
            if (name === 'SetWindowSubclass')
            {
                hooked.push(args.slice(1));
            }
            return 1;
        },
    } : undefined);
    /** @param {number} message @param {number} [wParam] @param {number} [lParam] */
    const send = (message, wParam = 0, lParam = 0)=>procedure(records[UPDOWN],
        { hwnd: UPDOWN, message, wParam, lParam });
    send(WM_CREATE);
    return {
        send, records, parent, edit, events, hooked, view, memory,
        text: ()=>editText,
        /** @param {string} value */
        setText: value=>{
            editText = value;
        },
        focus: ()=>focus,
    };
}

/** create_updown_control: buddy, a range of 0 to 100, and 50. @param {any} [options] */
async function made(options){
    const control = setup(options);
    await control.send(UDM_SETBUDDY, EDIT);
    await control.send(UDM_SETRANGE, 0, long(100, 0));
    await control.send(UDM_SETPOS, 0, long(50, 0));
    control.parent.length = 0;
    control.edit.length = 0;
    control.events.length = 0;
    return control;
}

test('an up-down control asks its parent for the notification format, and is the default '
    + 'width whatever it was made', async()=>{
    const control = setup();
    assert.equal(control.parent[0][0], WM_NOTIFYFORMAT);
    assert.equal(control.records[UPDOWN].width, DEFAULT_WIDTH);
    assert.equal(control.records[UPDOWN].height, 30, 'the height is the program\'s');
    assert.equal(await control.send(UDM_GETRANGE), long(0, 100), 'the range is 100 down to 0');
    assert.equal(await control.send(UDM_GETBASE), 10);
});

test('UDM_SETPOS clamps into the range, answers the position before, and raises '
    + 'EVENT_OBJECT_VALUECHANGE every time', async()=>{
    // test_updown_pos: without UDS_SETBUDDYINT the high word of UDM_GETPOS
    // is always 1.
    const control = await made({ style: UDS_ALIGNRIGHT });
    await control.send(UDM_SETRANGE, 0, long(100, 0));
    assert.equal(await control.send(UDM_GETRANGE), long(100, 0));
    await control.send(UDM_SETPOS, 0, long(5, 0));
    assert.equal(await control.send(UDM_GETPOS), long(5, 1));
    assert.equal(await control.send(UDM_SETPOS, 0, long(0, 0)), 5);
    assert.equal(await control.send(UDM_SETPOS, 0, long(-1, 0)), 0);
    assert.equal(await control.send(UDM_GETPOS), long(0, 1));
    assert.equal(await control.send(UDM_SETPOS, 0, long(100, 0)), 0);
    assert.equal(await control.send(UDM_SETPOS, 0, long(101, 0)), 100);
    assert.equal(await control.send(UDM_GETPOS), long(100, 1));
    assert.deepEqual(control.events, Array(5).fill([EVENT_OBJECT_VALUECHANGE, UPDOWN,
        OBJID_CLIENT, 0]));
    assert.equal(control.text(), '', 'no UDS_SETBUDDYINT, no text');
});

test('UDM_SETPOS32 and UDM_GETRANGE32 take the whole range, and UDM_GETPOS32 says through '
    + 'its pointer whether the buddy read failed', async()=>{
    const control = await made({ style: UDS_ALIGNRIGHT });
    await control.send(UDM_SETRANGE32, 0, 1000);
    await control.send(UDM_GETRANGE32, 0x100, 0x104);
    assert.deepEqual([control.view.getInt32(0x100, true), control.view.getInt32(0x104, true)],
        [0, 1000]);
    assert.equal(await control.send(UDM_SETPOS32, 0, 500), 50);
    assert.equal(await control.send(UDM_GETPOS32, 0, 0x108), 500);
    assert.equal(control.view.getUint32(0x108, true), 1);
    assert.equal(await control.send(UDM_SETPOS32, 0, -1), 500);
    assert.equal(await control.send(UDM_SETPOS32, 0, 1001), 0);
    assert.equal(await control.send(UDM_GETPOS32, 0, 0x108), 1000);
});

test('with UDS_SETBUDDYINT the buddy\'s text is read before it is written, and written only '
    + 'when it differs', async()=>{
    const control = setup({ style: UDS_ALIGNRIGHT | UDS_SETBUDDYINT });
    control.setText('50');
    await control.send(UDM_SETBUDDY, EDIT);
    await control.send(UDM_SETRANGE, 0, long(100, 0));
    await control.send(UDM_SETPOS, 0, long(50, 0));
    control.edit.length = 0;
    assert.equal(await control.send(UDM_SETPOS, 0, 50), 50);
    assert.deepEqual(control.edit, [WM_GETTEXT], 'test_updown_pos_nochange_seq');

    // An upside-down range: the position comes into it, and the buddy's
    // number out of it is a failed read.
    await control.send(UDM_SETRANGE, 0, long(1, 40));
    assert.equal(await control.send(UDM_GETRANGE), long(1, 40));
    assert.equal(await control.send(UDM_GETPOS), long(40, 1));
    assert.equal(await control.send(UDM_SETPOS, 0, long(0, 0)), 40);
    assert.equal(await control.send(UDM_GETPOS), long(1, 0));
    assert.equal(control.text(), '1');
});

test('UDS_SETBUDDYINT is read at creation only', async()=>{
    const without = await made({ style: UDS_ALIGNRIGHT });
    without.records[UPDOWN].style |= UDS_SETBUDDYINT;
    await without.send(UDM_SETPOS, 0, 20);
    assert.equal(without.text(), '');

    const withIt = await made({ style: UDS_ALIGNRIGHT | UDS_SETBUDDYINT });
    assert.equal(withIt.text(), '50');
    withIt.records[UPDOWN].style &= ~UDS_SETBUDDYINT;
    await withIt.send(UDM_SETPOS, 0, 20);
    assert.equal(withIt.text(), '20');
    withIt.setText('10');
    assert.equal(await withIt.send(UDM_GETPOS), 10);
    withIt.setText('21st');
    assert.equal(await withIt.send(UDM_GETPOS), long(10, 1), 'the last good number, and failed');
});

test('UDM_SETBASE takes 10 and 16 only, answers the base before, and rewrites the buddy',
    async()=>{
        const control = await made({ style: UDS_ALIGNRIGHT | UDS_SETBUDDYINT });
        assert.equal(await control.send(UDM_SETPOS, 0, 10), 50);
        assert.equal(control.text(), '10');
        assert.equal(await control.send(UDM_SETBASE, 80), 0);
        assert.equal(await control.send(UDM_GETBASE), 10);
        assert.equal(await control.send(UDM_SETBASE, 16), 10);
        assert.equal(control.text(), '0x000A');
        assert.equal(await control.send(UDM_SETBASE, 10), 16);
    });

test('UDM_SETUNICODEFORMAT answers the format before', async()=>{
    const control = await made();
    await control.send(UDM_SETUNICODEFORMAT, 0);
    assert.equal(await control.send(UDM_GETUNICODEFORMAT), 0);
    assert.equal(await control.send(UDM_SETUNICODEFORMAT, 1), 0);
    assert.equal(await control.send(UDM_SETUNICODEFORMAT, 0), 1);
});

test('the acceleration is three steps until set, and UDM_GETACCEL answers how many it has',
    async()=>{
        const control = await made();
        assert.equal(await control.send(UDM_GETACCEL, 0, 0x200), 3);
        assert.equal(await control.send(UDM_GETACCEL, 4, 0x200), 3);
        assert.deepEqual([0, 1, 2, 3, 4, 5].map(at=>control.view.getUint32(0x200 + at * 4, true)),
            [0, 1, 2, 5, 5, 20]);
        control.view.setUint32(0x300, 0, true);
        control.view.setUint32(0x304, 5, true);
        assert.equal(await control.send(UDM_SETACCEL, 1, 0x300), 1);
        assert.equal(await control.send(UDM_GETACCEL, 3, 0x200), 1);
        assert.equal(control.view.getUint32(0x204, true), 5);
    });

test('attached with UDS_ALIGNRIGHT it takes its width out of the buddy, each time', async()=>{
    const control = await made({ style: UDS_ALIGNRIGHT });
    const edit = control.records[EDIT];
    Object.assign(edit, { x: 100, y: 100, width: 100, height: 100 });
    await control.send(UDM_SETBUDDY, EDIT);
    assert.equal(edit.width, 100 - DEFAULT_WIDTH);
    assert.deepEqual([control.records[UPDOWN].x, control.records[UPDOWN].height],
        [100 + edit.width, 100]);
    assert.equal(await control.send(UDM_SETBUDDY, EDIT), EDIT, 'the buddy before');
    assert.equal(edit.width, 100 - 2 * DEFAULT_WIDTH);
    assert.equal(await control.send(UDM_SETBUDDY, 0), EDIT);
    assert.equal(await control.send(UDM_GETBUDDY), 0);
});

test('a click on the up arrow focuses the edit, asks UDN_DELTAPOS, steps and tells '
    + 'SB_THUMBPOSITION; letting go tells SB_ENDSCROLL', async()=>{
    const control = await made({ style: UDS_ALIGNRIGHT | UDS_SETBUDDYINT });
    const rect = control.records[UPDOWN];
    await control.send(WM_LBUTTONDOWN, 0, long(rect.width / 2, rect.height / 4));
    await control.send(WM_LBUTTONUP, 0, long(rect.width / 2, rect.height / 4));
    assert.equal(control.focus(), EDIT);
    assert.deepEqual(control.parent.map(([message, wParam, , code])=>[message, wParam, code]), [
        [WM_NOTIFY, 1, UDN_DELTAPOS],
        [WM_VSCROLL, long(SB_THUMBPOSITION, 51), 0],
        [WM_VSCROLL, long(SB_ENDSCROLL, 51), 0],
    ], 'test_updown_pos_notifications_seq, the edit\'s own notifications aside');
    assert.equal(control.text(), '51');
    assert.equal(control.parent[1][2], UPDOWN, 'lParam names the control');
});

test('a horizontal control steps right on its right half and tells WM_HSCROLL', async()=>{
    const control = await made({ style: UDS_ALIGNRIGHT | UDS_SETBUDDYINT | UDS_HORZ });
    const rect = control.records[UPDOWN];
    await control.send(WM_LBUTTONDOWN, 0, long(rect.width * 3 / 4, rect.height / 2));
    assert.deepEqual(control.parent.slice(1).map(([message, wParam])=>[message, wParam]),
        [[WM_HSCROLL, long(SB_THUMBPOSITION, 51)]]);
});

test('a parent that answers UDN_DELTAPOS with TRUE keeps the position', async()=>{
    const control = await made({ style: UDS_SETBUDDYINT, refuse: true });
    await control.send(WM_LBUTTONDOWN, 0, long(1, 1));
    assert.equal(await control.send(UDM_GETPOS), long(50, 0));
    assert.deepEqual(control.parent.map(([message])=>message), [WM_NOTIFY], 'and tells no scroll');
});

test('with UDS_ARROWKEYS the buddy is subclassed, and the up key steps toward the upper end',
    async()=>{
        const control = await made({ style: UDS_ARROWKEYS | UDS_SETBUDDYINT, subclass: true });
        assert.deepEqual(control.hooked, [[0x7f00, 1, UPDOWN]]);
        await control.send(UDM_SETRANGE, 0, long(1, 40));
        await control.send(UDM_SETPOS, 0, long(2, 0));
        await control.send(WM_KEYDOWN, VK_UP);
        assert.equal(await control.send(UDM_GETPOS), long(1, 0), 'up is toward 1, and stops there');

        const plain = await made({ style: UDS_SETBUDDYINT, subclass: true });
        assert.deepEqual(plain.hooked, [], 'no UDS_ARROWKEYS, no subclass');
    });

test('the buddy\'s number is grouped by thousands in base 10, 0x%04X in base 16', ()=>{
    assert.equal(formatPosition(1000, 10, true), '1,000');
    assert.equal(formatPosition(-1234567, 10, true), '-1,234,567');
    assert.equal(formatPosition(1000, 10, false), '1000');
    assert.equal(formatPosition(10, 16, true), '0x000A');
    assert.equal(parsePosition('1,000', 10), 1000);
    assert.equal(parsePosition('', 10), 0, 'an empty text is zero');
    assert.equal(parsePosition('21st', 10), null);
    assert.equal(parsePosition('0x000A', 16), 10);
    assert.equal(parsePosition(' -5', 10), -5);
});
