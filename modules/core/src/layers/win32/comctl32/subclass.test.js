/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubclassFunctions } from './subclass.js';
import { COMCTL32_ORDINALS } from './functions.js';

const HWND = 0x10020;
const WND_PROC_1 = 0x401000;
const WND_PROC_3 = 0x403000;
const SUB_PROC = 0x405000;
const OUT = 0x2000;
const GWLP_WNDPROC = -4;
const WM_USER = 0x0400;
const WM_NCDESTROY = 0x0082;
/** wnd_proc_sub's reference data, as comctl32's subclass test reads it. */
const SEND_NEST = 0x01;
const DELETE_SELF = 0x02;
const DELETE_PREV = 0x04;

/**
 * One window and the procedures of comctl32's subclass test: wnd_proc_1 the
 * class's, wnd_proc_3 one a program sets over everything, and wnd_proc_sub
 * every subclass, which records WM_USER as [its id, wParam] and, when lParam
 * is set, does what its reference data says.
 */
function setup(){
    const memory = new Uint8Array(0x3000);
    /** @type {number[][]} */
    const seen = [];
    const window = { proc: WND_PROC_1, unicode: false, alive: true };
    /** The window's properties, by name. @type {Map<string, number>} */
    const properties = new Map();
    let heap = 0x1000;
    /** @param {number} at */
    const readName = at=>String.fromCharCode(...memory.subarray(at, memory.indexOf(0, at)));
    /** @type {Map<number, (args: number[]) => any>} */
    const procedures = new Map();
    let orig3 = 0;
    // user32's procedure handles: a procedure read through the other
    // encoding's call is a handle, which sets it back as what it reads.
    /** @type {{ proc: number, unicode: boolean }[]} */
    const handles = [];
    /** @param {number} proc @param {boolean} unicode */
    const handleOf = (proc, unicode)=>{
        let at = handles.findIndex(each=>each.proc === proc && each.unicode === unicode);
        if (at < 0)
        {
            at = handles.push({ proc, unicode }) - 1;
        }
        return (0xffff0000 | at) >>> 0;
    };
    /** @param {number} value */
    const behind = value=>((value >>> 16) === 0xffff ? handles[value & 0xffff] : null);
    /** @param {boolean} reader */
    const read = reader=>(window.unicode === reader || procedures.has(window.proc)
        ? window.proc : handleOf(window.proc, window.unicode));
    /** @param {number} value @param {boolean} unicode */
    const set = (value, unicode)=>{
        const previous = read(unicode);
        const named = behind(value);
        window.proc = named ? named.proc : value;
        window.unicode = named ? named.unicode : unicode;
        return previous;
    };
    /** @type {Record<string, (args: number[]) => any>} */
    const user32 = {
        IsWindow: ([hwnd])=>(hwnd === HWND && window.alive ? 1 : 0),
        IsWindowUnicode: ()=>(window.unicode ? 1 : 0),
        GetWindowLongW: ()=>read(true),
        SetWindowLongW: ([, , value])=>set(value, true),
        SetWindowLongA: ([, , value])=>set(value, false),
        CallWindowProcW: ([proc, ...message])=>run(behind(proc)?.proc ?? proc, message),
        CallWindowProcA: ([proc, ...message])=>run(behind(proc)?.proc ?? proc, message),
        DefWindowProcW: ()=>0,
        DefWindowProcA: ()=>0,
        SetPropA: ([hwnd, name, value])=>{
            properties.set(readName(name), value);
            return hwnd === HWND ? 1 : 0;
        },
        RemovePropA: ([, name])=>{
            const had = properties.get(readName(name)) ?? 0;
            properties.delete(readName(name));
            return had;
        },
        SendMessage: message=>run(window.proc, message),
    };
    const fns = createSubclassFunctions({
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        user32: name=>(user32[name] ? { handler: user32[name] } : undefined),
        call: (entry, args)=>run(entry, args),
        callerThread: ()=>null,
        allocate: ()=>(heap += 0x40) - 0x40,
        release: ()=>{},
        procedure: (_name, handler)=>{
            const at = 0x7f000000 + procedures.size * 0x10;
            procedures.set(at, handler);
            return at;
        },
    });

    /** @param {number} proc @param {number[]} args */
    function run(proc, args){
        const [hwnd, message, wParam, lParam, id, ref] = args;
        const host = procedures.get(proc);
        if (host)
        {
            return host(args);
        }
        if (proc === WND_PROC_1)
        {
            if (message === WM_USER)
            {
                seen.push([1, wParam]);
            }
            return 0;
        }
        if (proc === WND_PROC_3)
        {
            if (message === WM_USER)
            {
                seen.push([3, wParam]);
            }
            return run(orig3, [hwnd, message, wParam, lParam]);
        }
        assert.equal(proc, SUB_PROC);
        if (message === WM_USER)
        {
            seen.push([id, wParam]);
            if (lParam)
            {
                if (ref & DELETE_SELF)
                {
                    fns.RemoveWindowSubclass.handler([hwnd, SUB_PROC, id]);
                    fns.RemoveWindowSubclass.handler([hwnd, SUB_PROC, id]);
                }
                if (ref & DELETE_PREV)
                {
                    fns.RemoveWindowSubclass.handler([hwnd, SUB_PROC, id - 1]);
                }
                if (ref & SEND_NEST)
                {
                    send(wParam + 1, 0);
                }
            }
        }
        return fns.DefSubclassProc.handler([hwnd, message, wParam, lParam]);
    }

    /** @param {number} wParam @param {number} lParam */
    const send = (wParam, lParam)=>run(window.proc, [HWND, WM_USER, wParam, lParam]);
    /** @param {number} id @param {number} ref */
    const subclass = (id, ref)=>fns.SetWindowSubclass.handler([HWND, SUB_PROC, id, ref]);
    const take = ()=>seen.splice(0);
    const overlay = ()=>{
        orig3 = user32.SetWindowLongA([HWND, GWLP_WNDPROC, WND_PROC_3]);
    };
    /** @param {number} message */
    const deliver = message=>run(window.proc, [HWND, message, 0, 0]);
    return { fns, window, send, subclass, take, overlay, memory, deliver, properties };
}

test('SetWindowSubclass and its family are exported by ordinals 410 to 413', ()=>{
    assert.equal(COMCTL32_ORDINALS[410], 'SetWindowSubclass');
    assert.equal(COMCTL32_ORDINALS[411], 'GetWindowSubclass');
    assert.equal(COMCTL32_ORDINALS[412], 'RemoveWindowSubclass');
    assert.equal(COMCTL32_ORDINALS[413], 'DefSubclassProc');
    const { fns } = setup();
    assert.deepEqual([fns.SetWindowSubclass.argBytes, fns.GetWindowSubclass.argBytes,
        fns.RemoveWindowSubclass.argBytes, fns.DefSubclassProc.argBytes], [16, 16, 12, 16]);
});

test('a subclass runs before the window\'s procedure, which it reaches through DefSubclassProc, '
    + 'and the window reads what its own procedure reads', ()=>{
    const { window, send, subclass, take } = setup();
    assert.equal(subclass(2, 0), 1);
    assert.equal(window.unicode, true, 'comctl32\'s procedure is set wide');
    assert.notEqual(window.proc, WND_PROC_1);
    send(1, 0);
    send(2, 0);
    assert.deepEqual(take(), [[2, 1], [1, 1], [2, 2], [1, 2]], 'Sub_BasicTest');
});

test('a subclassed window carries CC32SubclassInfo, and loses it with its last subclass', ()=>{
    const { fns, subclass, properties } = setup();
    subclass(2, 0);
    assert.ok(properties.get('CC32SubclassInfo'));
    subclass(3, 0);
    fns.RemoveWindowSubclass.handler([HWND, SUB_PROC, 2]);
    assert.ok(properties.get('CC32SubclassInfo'), 'one is left');
    fns.RemoveWindowSubclass.handler([HWND, SUB_PROC, 3]);
    assert.equal(properties.has('CC32SubclassInfo'), false);
});

test('a subclass that takes itself off finishes the message, and the window has its own '
    + 'procedure back once the message is out', ()=>{
    const { window, send, subclass, take } = setup();
    subclass(2, 0);
    assert.equal(subclass(2, DELETE_SELF), 1, 'installed again, it takes the new data');
    send(1, 1);
    assert.deepEqual(take(), [[2, 1], [1, 1]], 'Sub_DeletedTest');
    assert.equal(window.proc, WND_PROC_1);
    assert.equal(window.unicode, false, 'set back as it was set: ANSI');
    send(1, 0);
    assert.deepEqual(take(), [[1, 1]], 'Sub_AfterDeletedTest');
});

test('a procedure set over comctl32\'s runs first and keeps reaching the subclasses through it',
    ()=>{
        const { fns, window, send, subclass, take, overlay } = setup();
        subclass(2, 0);
        overlay();
        send(1, 0);
        send(2, 0);
        assert.deepEqual(take(), [[3, 1], [2, 1], [1, 1], [3, 2], [2, 2], [1, 2]],
            'Sub_OldAfterNewTest');
        subclass(4, 0);
        send(1, 0);
        assert.deepEqual(take(), [[3, 1], [4, 1], [2, 1], [1, 1]], 'Sub_MixTest');

        subclass(4, SEND_NEST);
        send(1, 1);
        assert.deepEqual(take(), [[3, 1], [4, 1], [3, 2], [4, 2], [2, 2], [1, 2], [2, 1], [1, 1]],
            'Sub_MixAndNestTest');

        subclass(4, SEND_NEST | DELETE_SELF);
        send(1, 1);
        assert.deepEqual(take(), [[3, 1], [4, 1], [3, 2], [2, 2], [1, 2], [2, 1], [1, 1]],
            'Sub_MixNestDelTest');

        subclass(4, 0);
        subclass(5, DELETE_PREV);
        send(1, 1);
        assert.deepEqual(take(), [[3, 1], [5, 1], [2, 1], [1, 1]], 'Sub_MixDelPrevTest');

        assert.equal(fns.RemoveWindowSubclass.handler([HWND, SUB_PROC, 2]), 1);
        assert.equal(fns.RemoveWindowSubclass.handler([HWND, SUB_PROC, 5]), 1);
        // The last taken off, and wnd_proc_3 still over comctl32's: nothing
        // is set back, and the original is still reached.
        assert.equal(window.proc, WND_PROC_3);
        send(1, 0);
        assert.deepEqual(take(), [[3, 1], [1, 1]]);
    });

test('SetWindowSubclass of no window or no procedure is FALSE', ()=>{
    const { fns, window } = setup();
    assert.equal(fns.SetWindowSubclass.handler([0, SUB_PROC, 1, 0]), 0);
    assert.equal(fns.SetWindowSubclass.handler([HWND, 0, 1, 0]), 0);
    assert.equal(fns.SetWindowSubclass.handler([HWND + 4, SUB_PROC, 1, 0]), 0);
    assert.equal(window.proc, WND_PROC_1, 'nothing was put in place');
});

test('GetWindowSubclass answers the data of a procedure and id installed, zero for another',
    ()=>{
        const { fns, memory, subclass } = setup();
        subclass(2, 7);
        const read = ()=>new DataView(memory.buffer).getUint32(OUT, true);
        /** @param {number} hwnd @param {number} proc @param {number} id */
        const get = (hwnd, proc, id)=>{
            new DataView(memory.buffer).setUint32(OUT, 0xdeadbeef, true);
            return fns.GetWindowSubclass.handler([hwnd, proc, id, OUT]);
        };
        assert.equal(get(0, SUB_PROC, 2), 0);
        assert.equal(read(), 0);
        assert.equal(get(HWND, 0, 2), 0);
        assert.equal(read(), 0);
        assert.equal(get(HWND, SUB_PROC, 0), 0);
        assert.equal(read(), 0);
        assert.equal(fns.GetWindowSubclass.handler([HWND, SUB_PROC, 2, 0]), 1, 'no pointer');
        assert.equal(get(HWND, SUB_PROC, 2), 1);
        assert.equal(read(), 7);
    });

test('RemoveWindowSubclass of what is not installed is FALSE; a window destroyed loses its '
    + 'subclasses', ()=>{
    const { fns, subclass, deliver } = setup();
    assert.equal(fns.RemoveWindowSubclass.handler([HWND, SUB_PROC, 2]), 0);
    subclass(2, 0);
    assert.equal(fns.RemoveWindowSubclass.handler([HWND, SUB_PROC, 3]), 0);
    fns.DefSubclassProc.handler([HWND, WM_NCDESTROY, 0, 0]);
    assert.equal(fns.GetWindowSubclass.handler([HWND, SUB_PROC, 2, 0]), 1,
        'DefSubclassProc from outside a subclass is only the default procedure');
    deliver(WM_NCDESTROY);
    assert.equal(fns.GetWindowSubclass.handler([HWND, SUB_PROC, 2, 0]), 0);
});
