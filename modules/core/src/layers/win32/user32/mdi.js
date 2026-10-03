/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The multiple-document interface: the MDIClient class, the window inside a
 * frame that keeps the frame's document windows, and what DefFrameProc and
 * DefMDIChildProc add to DefWindowProc.
 *
 * A frame makes its client in WM_CREATE with a CLIENTCREATESTRUCT -- the
 * Window menu and the first child's id. A child is a window CreateWindowEx
 * makes with WS_EX_MDICHILD inside the client, whether a program asks for it
 * there, with CreateMDIWindow or with the client's WM_MDICREATE: the client
 * gives it its style, place, size and id, and its WM_CREATE is handed an
 * MDICREATESTRUCT of what was asked -- CW_USEDEFAULT and all, its lParam the
 * creation parameter. The client keeps the children in their stacking
 * order, the first one the active one, and tells a child it is activated or
 * deactivated with WM_MDIACTIVATE, the deactivated window and the activated
 * one in its two parameters. Everything a document window is made of goes
 * through the window manager's own calls, so it is a window like any other.
 *
 * Every step names the thread whose call it answers: making a child, then
 * showing and activating it, are several procedures run one after another,
 * and past the first one's answer the thread on the processor is somebody
 * else.
 *
 * What is not here: the Window menu's list of the children, and a maximized
 * child's caption and buttons moving into the frame's menu bar.
 */

import { readU32, writeU32s } from './structs.js';

const WM_CREATE = 0x0001;
const WM_DESTROY = 0x0002;
const WM_SIZE = 0x0005;
const WM_SETFOCUS = 0x0007;
const WM_CLOSE = 0x0010;
const WM_CHILDACTIVATE = 0x0022;
const WM_NCACTIVATE = 0x0086;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_COMMAND = 0x0111;
const WM_SYSCOMMAND = 0x0112;
export const WM_MDICREATE = 0x0220;
export const WM_MDIDESTROY = 0x0221;
export const WM_MDIACTIVATE = 0x0222;
export const WM_MDIRESTORE = 0x0223;
export const WM_MDINEXT = 0x0224;
export const WM_MDIMAXIMIZE = 0x0225;
export const WM_MDITILE = 0x0226;
export const WM_MDICASCADE = 0x0227;
export const WM_MDIICONARRANGE = 0x0228;
export const WM_MDIGETACTIVE = 0x0229;
export const WM_MDISETMENU = 0x0230;
export const WM_MDIREFRESHMENU = 0x0234;

const SC_MAXIMIZE = 0xf030;
const SC_NEXTWINDOW = 0xf040;
const SC_CLOSE = 0xf060;
const SC_RESTORE = 0xf120;

const SW_RESTORE = 9;
const SW_SHOWMAXIMIZED = 3;

const WS_MAXIMIZEBOX = 0x00010000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_CAPTION = 0x00c00000;
const WS_MAXIMIZE = 0x01000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_DISABLED = 0x08000000;
const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_EX_MDICHILD = 0x00000040;
/** The client's style that hands a child the style it asked for and no more. */
const MDIS_ALLCHILDSTYLES = 0x0001;
const GWL_STYLE = -16;
const CW_USEDEFAULT = 0x80000000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const VK_CONTROL = 0x11;
const VK_F4 = 0x73;
const VK_F6 = 0x75;
/** How far each new child sits from the one before it, when it asks for no place. */
const CASCADE_STEP = 24;

/** @typedef {number | Promise<number>} Answer */

/**
 * @param {any} value @param {(value: any) => any} next
 * @returns {any}
 */
const then = (value, next)=>(value && typeof value.then === 'function'
    ? value.then(next) : next(value));

/**
 * Runs the steps one after another, each after the answer of the one before.
 *
 * @param {(() => any)[]} steps
 * @returns {any}
 */
const inTurn = steps=>steps.reduce((before, step)=>then(before, ()=>step()), 0);

/**
 * @param {{
 *     host: { readMemory: (address: number, length: number) => Uint8Array,
 *             writeMemory: (address: number, data: Uint8Array) => void,
 *             keyState?: (key: number) => number },
 *     call: (name: string, args: number[]) => any,
 *     send: (hwnd: number, message: number, wParam: number, lParam: number,
 *         thread?: unknown) => Answer,
 *     create: (args: number[], thread: unknown, unicode?: boolean) => Answer,
 *     show: (hwnd: number, cmdShow: number, thread: unknown) => Answer,
 *     focus: (hwnd: number, thread: unknown) => Answer,
 *     destroy: (hwnd: number, thread: unknown) => Answer,
 *     defWindowProc: (record: any, message: any, thread?: unknown) => Answer,
 *     sizeOf: (hwnd: number) => { width: number, height: number },
 * }} options
 *     `call` is for the calls that reach no procedure; the rest name the thread.
 */
export function createMdi(options){
    const { host, call, send, create, show, focus, destroy, defWindowProc, sizeOf } = options;
    /**
     * Each client's state, by its window: the Window menu, the first child's
     * id, the children by id, the active one, their stacking order (the
     * active one first), and whether the active one is maximized.
     *
     * @type {Map<number, { windowMenu: number, firstChild: number,
     *     ids: Map<number, number>, active: number, order: number[],
     *     maximized: boolean }>}
     */
    const clients = new Map();

    /** @param {number} hwnd */
    const parentOf = hwnd=>call('GetParent', [hwnd]) >>> 0;

    /**
     * Makes `child` the client's active window: the one before it told it is
     * deactivated, `child` raised, told it is activated and given the focus.
     *
     * @param {number} client @param {number} child @param {unknown} thread
     * @returns {any}
     */
    const activate = (client, child, thread)=>{
        const state = clients.get(client);
        const old = state?.active ?? 0;
        if (!state || (child !== 0 && !state.order.includes(child)) || child === old)
        {
            return 0;
        }
        // The one going is told while it is still the active one -- it asks
        // WM_MDIGETACTIVE and finds itself -- and the new one once it is.
        return inTurn([
            ()=>(old !== 0 ? send(old, WM_NCACTIVATE, 0, 0, thread) : 0),
            ()=>(old !== 0 ? send(old, WM_MDIACTIVATE, old, child, thread) : 0),
            ()=>{
                state.active = child;
                if (child !== 0)
                {
                    state.order = [child, ...state.order.filter(other=>other !== child)];
                }
                return 0;
            },
            ()=>(child !== 0
                ? call('SetWindowPos', [child, 0, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE]) : 0),
            ()=>(child !== 0 ? send(child, WM_NCACTIVATE, 1, 0, thread) : 0),
            ()=>(child !== 0 ? send(child, WM_MDIACTIVATE, old, child, thread) : 0),
            ()=>(child !== 0 ? focus(child, thread) : 0),
            ()=>0,
        ]);
    };

    /**
     * The window CreateWindowEx is asked for, as the client makes it when it
     * is an MDI child -- WS_EX_MDICHILD inside one of the clients here -- or
     * null. The style is the client's: what was asked with WS_CHILD and
     * WS_CLIPSIBLINGS under MDIS_ALLCHILDSTYLES, and otherwise a visible
     * captioned window with a sizing frame, its system menu and both boxes; a
     * popup it never is. A place and a size not given are the cascade's, each
     * child a step down and right of the one before and three quarters of the
     * client, and an id not given the first free from the client's first.
     *
     * @param {number[]} args  CreateWindowEx's twelve, the extended style first
     * @returns {null | { client: number, args: number[], asked: number[], refused?: boolean }}
     *     `asked` is the MDICREATESTRUCT the child's WM_CREATE is handed;
     *     `refused` a popup asked for under MDIS_ALLCHILDSTYLES, which is none.
     */
    const childOf = args=>{
        const [exStyle, className, title, style, x, y, width, height, parent, menu, instance,
            params] = args;
        const client = parent >>> 0;
        const state = clients.get(client);
        if (!state || (exStyle & WS_EX_MDICHILD) === 0)
        {
            return null;
        }
        const all = (call('GetWindowLongA', [client, GWL_STYLE]) & MDIS_ALLCHILDSTYLES) !== 0;
        if (all && (style & WS_POPUP) !== 0)
        {
            return { client, args, asked: [], refused: true };
        }
        const childStyle = ((all ? style | WS_CHILD | WS_CLIPSIBLINGS
            : style | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CAPTION | WS_SYSMENU
                | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) & ~WS_POPUP) >>> 0;
        const step = (state.order.length % 8) * CASCADE_STEP;
        const room = sizeOf(client);
        const placed = (x >>> 0) !== CW_USEDEFAULT;
        const sized = (width >>> 0) !== CW_USEDEFAULT;
        let id = menu >>> 0;
        if (id === 0)
        {
            id = state.firstChild;
            while (state.ids.has(id))
            {
                id++;
            }
        }
        return {
            client,
            args: [exStyle, className, title, childStyle, placed ? x : step, placed ? y : step,
                sized ? width : Math.max(1, Math.floor(room.width * 3 / 4)),
                sized ? height : Math.max(1, Math.floor(room.height * 3 / 4)),
                client, id, instance, params],
            asked: [className, title, instance, x, y, width, height, style, params ?? 0],
        };
    };

    /**
     * A child just made becomes the client's: kept by its id and in the
     * stacking order, maximized when it was asked to be, and activated when
     * it is shown and enabled -- a disabled window is never activated.
     *
     * @param {number} client @param {number} child @param {unknown} thread
     * @returns {any}
     */
    const adopt = (client, child, thread)=>{
        const state = clients.get(client);
        if (!state)
        {
            return 0;
        }
        state.ids.set(call('GetDlgCtrlID', [child]) >>> 0, child);
        state.order.push(child);
        const style = call('GetWindowLongA', [child, GWL_STYLE]) >>> 0;
        return inTurn([
            ()=>((style & WS_MAXIMIZE) !== 0 ? show(child, SW_SHOWMAXIMIZED, thread) : 0),
            ()=>{
                state.maximized = state.maximized || (style & WS_MAXIMIZE) !== 0;
                return (style & WS_VISIBLE) !== 0 && (style & WS_DISABLED) === 0
                    ? activate(client, child, thread) : 0;
            },
            ()=>0,
        ]);
    };

    /**
     * WM_MDICREATE: the child the MDICREATESTRUCT asks for, made as
     * CreateWindowEx makes an MDI child, its creation parameter the
     * structure's lParam.
     *
     * @param {number} client @param {number} params  the MDICREATESTRUCT
     * @param {unknown} thread @param {boolean} unicode  whether its names are wide
     * @returns {any} the child, or 0
     */
    const createChild = (client, params, thread, unicode)=>{
        if (!clients.has(client) || (params >>> 0) === 0)
        {
            return 0;
        }
        const [className, title, owner, x, y, width, height, style, lParam]
            = [0, 4, 8, 12, 16, 20, 24, 28, 32].map(offset=>readU32(host, (params >>> 0) + offset));
        return create([WS_EX_MDICHILD, className, title, style, x, y, width, height, client, 0,
            owner, lParam], thread, unicode);
    };

    /**
     * WM_MDIDESTROY: the child goes, the next in the stacking order active in
     * its place first.
     *
     * @param {number} client @param {number} child @param {unknown} thread
     * @returns {any}
     */
    const destroyChild = (client, child, thread)=>{
        const state = clients.get(client);
        if (!state || !state.order.includes(child))
        {
            return 0;
        }
        const next = state.order.find(other=>other !== child) ?? 0;
        return inTurn([
            ()=>(state.active === child ? activate(client, next, thread) : 0),
            ()=>{
                state.order = state.order.filter(other=>other !== child);
                for (const [id, window] of state.ids)
                {
                    if (window === child)
                    {
                        state.ids.delete(id);
                    }
                }
                if (state.order.length === 0)
                {
                    state.maximized = false;
                }
                return destroy(child, thread);
            },
            ()=>0,
        ]);
    };

    /**
     * The MDIClient class's window procedure.
     *
     * @param {any} record @param {{ hwnd: number, message: number, wParam: number,
     *     lParam: number }} message @param {unknown} [thread]
     * @returns {any}
     */
    const procedure = (record, message, thread)=>{
        const client = message.hwnd >>> 0;
        const wParam = message.wParam >>> 0;
        const lParam = message.lParam >>> 0;
        const state = clients.get(client);
        switch (message.message >>> 0){
            case WM_CREATE: {
                // CREATESTRUCT.lpCreateParams, the CLIENTCREATESTRUCT -- or, with
                // no structure handed to a procedure on this side, the record's.
                const params = lParam !== 0 ? readU32(host, lParam) : record?.createParams ?? 0;
                clients.set(client, {
                    windowMenu: params === 0 ? 0 : readU32(host, params),
                    firstChild: params === 0 ? 0 : readU32(host, params + 4),
                    ids: new Map(), active: 0, order: [], maximized: false,
                });
                return 0;
            }
            case WM_DESTROY:
                clients.delete(client);
                break;
            case WM_MDICREATE:
                return createChild(client, lParam, thread,
                    /** @type {any} */ (message).unicode === true);
            case WM_MDIDESTROY:
                return destroyChild(client, wParam, thread);
            case WM_MDIACTIVATE:
                return then(activate(client, wParam, thread), ()=>0);
            case WM_MDIGETACTIVE:
                if (lParam !== 0)
                {
                    writeU32s(host, lParam, [state?.maximized && state.active !== 0 ? 1 : 0]);
                }
                return state?.active ?? 0;
            case WM_MDINEXT: {
                if (!state || state.order.length < 2)
                {
                    return 0;
                }
                // The next behind the active one, or with lParam the one at the back.
                const target = lParam !== 0 ? state.order[state.order.length - 1] : state.order[1];
                return then(activate(client, target, thread), ()=>0);
            }
            case WM_MDIMAXIMIZE:
                if (state && state.order.includes(wParam))
                {
                    state.maximized = true;
                    return then(show(wParam, SW_SHOWMAXIMIZED, thread), ()=>0);
                }
                return 0;
            case WM_MDIRESTORE:
                if (state && state.order.includes(wParam))
                {
                    state.maximized = false;
                    return then(show(wParam, SW_RESTORE, thread), ()=>0);
                }
                return 0;
            case WM_MDICASCADE: case WM_MDITILE: case WM_MDIICONARRANGE:
                return state && state.order.length > 0 ? 1 : 0;
            case WM_MDISETMENU: {
                const frame = parentOf(client);
                const previous = call('GetMenu', [frame]) >>> 0;
                if (state && lParam !== 0)
                {
                    state.windowMenu = lParam;
                }
                if (wParam === 0)
                {
                    return previous;
                }
                return then(call('SetMenu', [frame, wParam]), ()=>previous);
            }
            case WM_MDIREFRESHMENU:
                return call('GetMenu', [parentOf(client)]) >>> 0;
            case WM_SETFOCUS:
                if (state && state.active !== 0)
                {
                    return then(focus(state.active, thread), ()=>0);
                }
                break;
            default:
                break;
        }
        return defWindowProc(record, message, thread);
    };

    /**
     * DefFrameProc's own part, or null for what goes to DefWindowProc: a
     * command naming a child chooses it, a new size is the client's too, and
     * the focus goes to the client and through it to the active child.
     *
     * @param {number[]} args  hwnd, hwndMDIClient, message, wParam, lParam
     * @param {unknown} thread
     * @returns {any}
     */
    const defFrame = ([, clientArg, message, wParam, lParam], thread)=>{
        const client = clientArg >>> 0;
        const state = clients.get(client);
        if (!state)
        {
            return null;
        }
        switch (message >>> 0){
            case WM_COMMAND: {
                const child = state.ids.get(wParam & 0xffff);
                return child !== undefined && (lParam >>> 0) === 0
                    ? then(activate(client, child, thread), ()=>0) : null;
            }
            case WM_SIZE:
                return then(call('MoveWindow', [client, 0, 0, lParam & 0xffff,
                    lParam >>> 16 & 0xffff, 1]), ()=>0);
            case WM_SETFOCUS:
                return then(focus(client, thread), ()=>0);
            default:
                return null;
        }
    };

    /**
     * DefMDIChildProc's own part, or null for what goes to DefWindowProc:
     * activation and focus make the child the active one, closing it is the
     * client's WM_MDIDESTROY, and the system menu's commands are the client's.
     *
     * @param {number[]} args  hwnd, message, wParam, lParam
     * @param {unknown} thread
     * @returns {any}
     */
    const defChild = ([hwnd, message, wParam], thread)=>{
        const child = hwnd >>> 0;
        const client = parentOf(child);
        const state = clients.get(client);
        if (!state)
        {
            return null;
        }
        switch (message >>> 0){
            // A disabled child is told and stays as it is.
            case WM_CHILDACTIVATE:
                return (call('GetWindowLongA', [child, GWL_STYLE]) & WS_DISABLED) !== 0 ? 0
                    : then(activate(client, child, thread), ()=>0);
            case WM_SETFOCUS:
                return state.active === child ? null
                    : then(activate(client, child, thread), ()=>null);
            case WM_CLOSE:
                return then(send(client, WM_MDIDESTROY, child, 0, thread), ()=>0);
            case WM_SYSCOMMAND:
                switch (wParam & 0xfff0){
                    case SC_CLOSE:
                        return then(send(child, WM_CLOSE, 0, 0, thread), ()=>0);
                    case SC_MAXIMIZE:
                        return then(send(client, WM_MDIMAXIMIZE, child, 0, thread), ()=>0);
                    case SC_RESTORE:
                        return then(send(client, WM_MDIRESTORE, child, 0, thread), ()=>0);
                    case SC_NEXTWINDOW:
                        return then(send(client, WM_MDINEXT, child, 0, thread), ()=>0);
                    default:
                        return null;
                }
            default:
                return null;
        }
    };

    /**
     * TranslateMDISysAccel's answer for one message: Ctrl+F4 closes the active
     * child and Ctrl+F6 moves to the next, as a child's system menu does.
     *
     * @param {number} client @param {number} msg  the MSG @param {unknown} thread
     * @returns {any} 1 when the key was one of those
     */
    const translateAccelerator = (client, msg, thread)=>{
        const state = clients.get(client >>> 0);
        if (!state || (msg >>> 0) === 0 || state.active === 0)
        {
            return 0;
        }
        const message = readU32(host, (msg >>> 0) + 4);
        const key = readU32(host, (msg >>> 0) + 8);
        const control = ((host.keyState?.(VK_CONTROL) ?? 0) & 0x8000) !== 0;
        if ((message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN) || !control
            || (key !== VK_F4 && key !== VK_F6))
        {
            return 0;
        }
        return then(send(state.active, WM_SYSCOMMAND, key === VK_F4 ? SC_CLOSE : SC_NEXTWINDOW,
            0, thread), ()=>1);
    };

    return { procedure, defFrame, defChild, translateAccelerator, childOf, adopt, clients };
}
