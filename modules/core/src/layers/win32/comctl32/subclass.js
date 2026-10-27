/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32's window subclassing: SetWindowSubclass (#410),
 * GetWindowSubclass (#411), RemoveWindowSubclass (#412) and DefSubclassProc
 * (#413).
 *
 * A window subclassed so has one procedure of comctl32's in place of its own,
 * and that procedure runs the window's
 * subclasses, newest first: each is handed the message with its own id and
 * reference data, and passes it on with DefSubclassProc to the next older
 * one still installed, the oldest to the procedure the window had. A
 * subclass taken off while a message is in it still finishes that message
 * through DefSubclassProc, and one taken off further down the chain is
 * passed over. The window gets its own procedure back when the last subclass
 * is taken off and the outermost message in comctl32's procedure has
 * returned -- unless somebody has set another procedure over comctl32's
 * meanwhile, which then keeps calling it, and finds the original through it.
 *
 * While subclassed the window carries the property "CC32SubclassInfo", as
 * the 5.8 library marks its windows, and a program may look for it.
 *
 * comctl32's procedure is set wide, as Windows sets it, and passes messages
 * on wide: the window's own procedure, read through GetWindowLongW, is a
 * procedure handle when it reads ANSI, and CallWindowProcW converts the
 * message for it; set back through SetWindowLongW, the handle makes it the
 * ANSI procedure it was.
 */

const GWLP_WNDPROC = -4;
const WM_NCDESTROY = 0x0082;
const PROPERTY = 'CC32SubclassInfo';

/**
 * @typedef {Object} SubclassHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [user32]
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>} [call]
 * @property {() => unknown} [callerThread]
 * @property {(name: string, handler: (args: number[]) => number | Promise<number>) => number}
 *     [procedure]  An address the guest can call that runs `handler`.
 * @property {(bytes: number) => number} [allocate]
 *     Guest memory for the property's name, as long as the call naming it.
 * @property {(address: number) => void} [release]
 */

/**
 * @typedef {Object} Subclass
 * @property {number} proc
 * @property {number} id
 * @property {number} ref
 * @property {number} order  When it was installed: an older one has a lower order.
 */

/**
 * @typedef {Object} Subclassed
 * @property {Subclass[]} chain     Oldest first.
 * @property {number} original      The procedure the window had, as SetWindowLongW
 *     answered it: a handle when it reads ANSI.
 * @property {number[]} running     The order of each subclass a message is in, innermost last.
 */

/** @param {unknown} value @param {(answer: any) => any} then */
const andThen = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<unknown>} */ (value).then(then) : then(value));

/**
 * @param {SubclassHost} host
 */
export function createSubclassFunctions(host){
    /** @type {Map<number, Subclassed>} */
    const windows = new Map();
    let installed = 0;
    /** comctl32's procedure, made once, the first time a window is subclassed. */
    let stub = 0;

    /** @param {string} name @param {number[]} args */
    const user32 = (name, args)=>host.user32?.(name)?.handler(args) ?? 0;

    /**
     * SetPropA or RemovePropA of the property that marks a subclassed window.
     *
     * @param {string} call @param {number} hwnd @param {number[]} [rest]
     */
    const property = (call, hwnd, rest = [])=>{
        const name = host.allocate?.(PROPERTY.length + 1) ?? 0;
        if (name === 0)
        {
            return;
        }
        host.writeMemory(name, new Uint8Array([...PROPERTY].map(c=>c.charCodeAt(0)).concat(0)));
        user32(call, [hwnd, name, ...rest]);
        host.release?.(name);
    };

    /**
     * Runs the newest subclass older than `below`, or the window's own
     * procedure when there is none.
     *
     * @param {number} hwnd @param {Subclassed} held @param {number} below
     * @param {number[]} message  msg, wParam, lParam.
     * @returns {number | Promise<number>}
     */
    const runFrom = (hwnd, held, below, message)=>{
        const next = held.chain.filter(each=>each.order < below).at(-1);
        if (!next || !host.call)
        {
            return user32('CallWindowProcW', [held.original, hwnd, ...message]);
        }
        held.running.push(next.order);
        return andThen(host.call(next.proc, [hwnd, ...message, next.id, next.ref],
            host.callerThread?.()), answer=>{
            held.running.pop();
            return answer;
        });
    };

    /**
     * The window's own procedure back, once nothing is subclassing it and no
     * message is inside comctl32's procedure -- as long as that procedure is
     * still the window's.
     *
     * @param {number} hwnd @param {Subclassed} held
     */
    const settle = (hwnd, held)=>{
        if (held.chain.length !== 0 || held.running.length !== 0)
        {
            return;
        }
        if ((user32('GetWindowLongW', [hwnd, GWLP_WNDPROC]) >>> 0) === stub)
        {
            user32('SetWindowLongW', [hwnd, GWLP_WNDPROC, held.original]);
            property('RemovePropA', hwnd);
            windows.delete(hwnd);
        }
    };

    /**
     * comctl32's procedure: every message to a subclassed window.
     *
     * @param {number[]} args
     */
    const dispatch = ([hwnd, message, wParam, lParam])=>{
        const held = windows.get(hwnd >>> 0);
        if (!held)
        {
            return user32('DefWindowProcW', [hwnd, message, wParam, lParam]);
        }
        return andThen(runFrom(hwnd >>> 0, held, Infinity, [message, wParam, lParam]), answer=>{
            // A window being destroyed takes its subclasses with it.
            if ((message >>> 0) === WM_NCDESTROY && held.running.length === 0)
            {
                property('RemovePropA', hwnd >>> 0);
                windows.delete(hwnd >>> 0);
                return answer;
            }
            settle(hwnd >>> 0, held);
            return answer;
        });
    };

    return {
        /**
         * BOOL SetWindowSubclass(HWND hWnd, SUBCLASSPROC pfnSubclass,
         *                        UINT_PTR uIdSubclass, DWORD_PTR dwRefData)
         *
         * A procedure and id already installed keep their place and take the
         * new data. No window, or no procedure, is FALSE.
         */
        SetWindowSubclass: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, proc, id, ref])=>{
                if ((proc >>> 0) === 0 || (hwnd >>> 0) === 0 || !user32('IsWindow', [hwnd])
                    || !host.procedure)
                {
                    return 0;
                }
                let held = windows.get(hwnd >>> 0);
                if (!held)
                {
                    stub ||= host.procedure('comctl32 subclass', dispatch);
                    held = {
                        chain: [], running: [],
                        original: user32('SetWindowLongW', [hwnd, GWLP_WNDPROC, stub]) >>> 0,
                    };
                    windows.set(hwnd >>> 0, held);
                    property('SetPropA', hwnd, [1]);
                }
                const same = held.chain.find(each=>each.proc === (proc >>> 0)
                    && each.id === (id >>> 0));
                if (same)
                {
                    same.ref = ref >>> 0;
                }
                else
                {
                    held.chain.push({ proc: proc >>> 0, id: id >>> 0, ref: ref >>> 0,
                        order: ++installed });
                }
                return 1;
            },
        },

        /**
         * BOOL GetWindowSubclass(HWND hWnd, SUBCLASSPROC pfnSubclass,
         *                        UINT_PTR uIdSubclass, DWORD_PTR *pdwRefData)
         *
         * The data a subclass was installed with; zero through the pointer
         * when there is no such subclass.
         */
        GetWindowSubclass: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, proc, id, out])=>{
                const found = windows.get(hwnd >>> 0)?.chain.find(each=>each.proc === (proc >>> 0)
                    && each.id === (id >>> 0));
                if ((out >>> 0) !== 0)
                {
                    const bytes = new Uint8Array(4);
                    new DataView(bytes.buffer).setUint32(0, found?.ref ?? 0, true);
                    host.writeMemory(out >>> 0, bytes);
                }
                return found ? 1 : 0;
            },
        },

        /** BOOL RemoveWindowSubclass(HWND hWnd, SUBCLASSPROC pfnSubclass, UINT_PTR uIdSubclass) */
        RemoveWindowSubclass: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, proc, id])=>{
                const held = windows.get(hwnd >>> 0);
                const at = held?.chain.findIndex(each=>each.proc === (proc >>> 0)
                    && each.id === (id >>> 0)) ?? -1;
                if (!held || at < 0)
                {
                    return 0;
                }
                held.chain.splice(at, 1);
                settle(hwnd >>> 0, held);
                return 1;
            },
        },

        /**
         * LRESULT DefSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam)
         *
         * The next older subclass of the one this message is in, or the
         * window's own procedure. Called from outside any subclass, it is
         * the default procedure's answer.
         */
        DefSubclassProc: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                const held = windows.get(hwnd >>> 0);
                const inside = held?.running.at(-1);
                if (!held || inside === undefined)
                {
                    return user32('DefWindowProcW', [hwnd, message, wParam, lParam]);
                }
                return runFrom(hwnd >>> 0, held, inside, [message, wParam, lParam]);
            },
        },
    };
}
