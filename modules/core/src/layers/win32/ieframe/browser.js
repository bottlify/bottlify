/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WebBrowser control (decision A240): Internet Explorer's ActiveX
 * control as a container embeds it - WPF's and Windows Forms' WebBrowser,
 * a launcher's news pane.
 *
 * Everything a container does with the control is done: it is made, takes
 * its client site, activates in place in the site's window with the three
 * windows IE makes there ("Shell Embedding", "Shell DocObject View",
 * "Internet Explorer_Server"), is moved and deactivated; it navigates, keeps
 * its location, ready state, history and properties, and tells the
 * program's sinks what IE tells them, in IE's order: BeforeNavigate2 at
 * once (a sink may cancel), the rest from the control window's message
 * loop. There is no HTML engine behind it: the page is not drawn (the
 * server window shows its white background) and has no document, and that
 * is said as a loss once for each address.
 */

import { createComObject } from '../ole32/objects.js';
import { canonicalGuid, parseGuid } from '../ole32/guid.js';
import { IID_ITYPEINFO, createClassInfo } from './classinfo.js';
import {
    CLIENT_SITE, CLSID_WEB_BROWSER, CLSID_WEB_BROWSER_V1, CONNECTION_POINT, CONTROL_SITE,
    DIID_DWEB_BROWSER_EVENTS, DIID_DWEB_BROWSER_EVENTS2, DISPID, DISPID_AMBIENT, IID_IDISPATCH,
    IID_IOLE_COMMAND_TARGET, IID_IOLE_CONTROL_SITE, IID_IOLE_IN_PLACE_SITE, IID_IOLE_WINDOW,
    IID_IPROPERTY_NOTIFY_SINK, INTERFACES, IN_PLACE_FRAME, IN_PLACE_SITE,
} from './layout.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const E_FAIL = 0x80004005;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;
const E_UNEXPECTED = 0x8000ffff;
const OLECMDERR_E_UNKNOWNGROUP = 0x80040104;
/** OLECMDID_SETDOWNLOADSTATE, how IE tells its container's command target it downloads. */
const OLECMDID_SETDOWNLOADSTATE = 29;
const SLOT_EXEC = 4;
const CONNECT_E_NOCONNECTION = 0x80040200;
const CONNECT_E_CANNOTCONNECT = 0x80040202;

/** OLEIVERB_*: the verbs DoVerb takes that activate the control. */
const OLEIVERB_PRIMARY = 0;
const OLEIVERB_SHOW = -1;
const OLEIVERB_OPEN = -2;
const OLEIVERB_HIDE = -3;
const OLEIVERB_UIACTIVATE = -4;
const OLEIVERB_INPLACEACTIVATE = -5;

/** The verbs EnumVerbs lists, in IE's order. */
const VERBS = [OLEIVERB_PRIMARY, OLEIVERB_INPLACEACTIVATE, OLEIVERB_UIACTIVATE, OLEIVERB_SHOW,
    OLEIVERB_HIDE];
const IID_IENUM_OLEVERB = '{00000104-0000-0000-C000-000000000046}';

/** OLEMISC: what GetMiscStatus answers for every aspect. */
const MISC_STATUS = 0x20000 | 0x100 | 0x80 | 0x10 | 0x1;

/** READYSTATE. */
const READYSTATE_UNINITIALIZED = 0;
const READYSTATE_LOADING = 1;
const READYSTATE_INTERACTIVE = 3;
const READYSTATE_COMPLETE = 4;

/** VARIANT types. */
const VT_I4 = 3;
const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_BYREF = 0x4000;
const VARIANT_SIZE = 16;
const VARIANT_TRUE = 0xffff;

/** CSC_*: the commands CommandStateChange names. */
const CSC_NAVIGATEFORWARD = 1;
const CSC_NAVIGATEBACK = 2;

/** OLE_E_NOCONNECTION: IOleObject::Unadvise of a connection it has not. */
const OLE_E_NOCONNECTION = 0x80040004;

/** GUIDKIND_DEFAULT_SOURCE_DISP_IID, the one GetGUID answers. */
const GUIDKIND_DEFAULT_SOURCE_DISP_IID = 1;

/**
 * The windows' styles: each a child clipping its siblings and children,
 * the outer one hidden until the control is activated, as IE makes it when
 * it is given its site; a popup when the site has no window.
 */
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIP = 0x06000000;
/** ShowWindow's values. */
const SW_SHOW = 5;
const SW_HIDE = 0;
/** How an event is invoked on a sink, and an ambient property read. */
const DISPATCH_METHOD = 1;
const DISPATCH_PROPERTYGET = 2;
/** IDispatch::Invoke's slot, and IUnknown's three. */
const SLOT_QUERY = 0;
const SLOT_ADDREF = 1;
const SLOT_RELEASE = 2;
const SLOT_INVOKE = 6;
/** IPropertyNotifySink::OnChanged. */
const SLOT_ON_CHANGED = 3;

/**
 * The message the control posts its own window to finish a navigation from
 * the message loop, as IE does: in the range Windows leaves to a class.
 */
export const WM_BROWSER_NAVIGATED = 0x8000 + 0x1b0;

/** The window classes, the outer first: each the parent of the next. */
export const BROWSER_CLASSES = Object.freeze(['Shell Embedding', 'Shell DocObject View',
    'Internet Explorer_Server']);

/**
 * @typedef {Object} BrowserHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 * @property {{ publish: (object: any, iid: string) => number }} vtables
 * @property {(call: { entry: number, args: number[], thread?: unknown }) => Promise<number>}
 *     callGuest
 * @property {() => unknown} callerThread
 * @property {(library: string, name: string, args: number[], thread?: unknown)
 *     => number | Promise<number> | null} system
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * @param {BrowserHost} host
 */
export function createBrowsers(host){
    /** @param {number} at */
    const u32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer).getUint32(0, true);
    /** @param {number} at @param {number[]} values */
    const putU32s = (at, values)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array(values.map(value=>value >>> 0)).buffer));
    /** @param {number} at @param {number} value */
    const putU16 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint16Array([value & 0xffff]).buffer));
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = host.heap.allocate(bytes) >>> 0;
        if (at !== 0)
        {
            host.writeMemory(at, new Uint8Array(bytes));
        }
        return at;
    };
    /** A wide string up to its terminator, or ''. @param {number} at */
    const wideAt = at=>{
        if ((at >>> 0) === 0)
        {
            return '';
        }
        let text = '';
        for (let p = at >>> 0; text.length < 0x10000; p += 2)
        {
            const unit = new DataView(host.readMemory(p, 2).slice().buffer).getUint16(0, true);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };
    /** A string written as a guest wide string, kept for good. @param {string} text */
    const keptWide = text=>{
        const at = allocate((text.length + 1) * 2);
        [...text].forEach((char, index)=>putU16(at + index * 2, char.charCodeAt(0)));
        return at;
    };
    /** A BSTR the receiver frees with SysFreeString, or 0. @param {string} text */
    const bstr = text=>{
        const at = Number(host.system('OLEAUT32.dll', 'SysAllocStringLen', [0, text.length]) ?? 0)
            >>> 0;
        if (at !== 0)
        {
            [...text].forEach((char, index)=>putU16(at + index * 2, char.charCodeAt(0)));
        }
        return at;
    };
    /** @param {number} at */
    const freeBstr = at=>{
        if (at !== 0)
        {
            host.system('OLEAUT32.dll', 'SysFreeString', [at]);
        }
    };

    /**
     * A method of an object the program holds, through its own table.
     *
     * @param {unknown} thread @param {number} pointer @param {number} slot @param {number[]} args
     */
    const method = (thread, pointer, slot, args)=>host.callGuest({
        entry: u32(u32(pointer) + slot * 4), args: [pointer >>> 0, ...args.map(arg=>arg >>> 0)],
        ...(thread === undefined ? {} : { thread }) }).then(hr=>hr >>> 0);

    /**
     * The program object's interface, its reference taken, or 0.
     *
     * @param {unknown} thread @param {number} pointer @param {string} iid
     */
    const query = async(thread, pointer, iid)=>{
        const block = allocate(20);
        if (block === 0)
        {
            return 0;
        }
        host.writeMemory(block + 4, /** @type {Uint8Array} */ (parseGuid(iid)));
        const hr = await method(thread, pointer, SLOT_QUERY, [block + 4, block]);
        const out = hr === S_OK ? u32(block) : 0;
        host.heap.free(block);
        return out;
    };

    /** Said once each: the addresses not drawn, the calls not made. */
    const said = new Set();
    /** @param {string} api @param {string} detail @param {'loss'} [kind] */
    const sayOnce = (api, detail, kind)=>{
        if (!said.has(`${api}:${detail}`))
        {
            said.add(`${api}:${detail}`);
            host.divergence?.(api, detail, kind);
        }
    };

    const classInfo = createClassInfo({ writeMemory: host.writeMemory, heap: host.heap, bstr,
        sayOnce });

    /** Browser sessions open in the process: one for each control with a site. */
    let sessions = 0;

    /** The control behind each of its windows, for the class procedure. @type {Map<number, any>} */
    const byWindow = new Map();
    /** The name IE gives itself to the frame, as a guest string made once. */
    let item = 0;
    const itemName = ()=>(item === 0 ? (item = keptWide('item')) : item);

    /** The class names as guest strings, made at the first activation. */
    /** @type {number[]} */
    let classNames = [];
    let emptyName = 0;

    /**
     * @typedef {{ vt: number, value?: number, text?: string | null, inner?: EventArg }} EventArg
     *     An event argument: a BSTR's text (null for a NULL BSTR), a by-reference
     *     VARIANT's inner VARIANT, any other's value (a by-reference one's cell).
     */

    /**
     * An event to every sink advised on an event interface, in the order
     * they were advised: the arguments as IE passes them (a URL as a VARIANT
     * by reference holding a BSTR, Cancel as a VARIANT_BOOL by reference),
     * last first in the DISPPARAMS, which has no array at all for an event
     * without arguments. What a by-reference cell holds after the sinks ran
     * is answered, so Cancel can be read.
     *
     * @param {any} object @param {string} source @param {number} dispid
     * @param {EventArg[]} args @param {unknown} thread
     * @returns {Promise<number[]>} each argument's value after the call
     */
    const fire = async(object, source, dispid, args, thread)=>{
        const sinks = [...(object.state.sinks.get(source)?.values() ?? [])];
        const values = args.map(arg=>arg.value ?? 0);
        if (sinks.length === 0)
        {
            return values;
        }
        // DISPPARAMS, IID_NULL, then the arguments' VARIANTs.
        const count = args.length;
        const block = allocate(16 + 16 + count * VARIANT_SIZE);
        if (block === 0)
        {
            return values;
        }
        const rgvarg = count === 0 ? 0 : block + 32;
        /** @type {number[]} */
        const strings = [];
        /** @type {number[]} */
        const cells = [];
        /** @param {number} at @param {EventArg} arg @returns {number} the by-reference cell */
        const putVariant = (at, arg)=>{
            putU16(at, arg.vt);
            if (arg.vt === VT_BSTR)
            {
                const made = arg.text === null || arg.text === undefined ? 0 : bstr(arg.text);
                if (made !== 0)
                {
                    strings.push(made);
                }
                putU32s(at + 8, [made]);
                return 0;
            }
            if ((arg.vt & VT_BYREF) === 0)
            {
                putU32s(at + 8, [arg.value ?? 0]);
                return 0;
            }
            const cell = allocate(VARIANT_SIZE);
            cells.push(cell);
            if (arg.vt === (VT_BYREF | VT_VARIANT) && arg.inner)
            {
                putVariant(cell, arg.inner);
            }
            else
            {
                putU32s(cell, [arg.value ?? 0]);
            }
            putU32s(at + 8, [cell]);
            return cell;
        };
        // The last argument first.
        const byReference = args.map((arg, index)=>putVariant(
            rgvarg + (count - 1 - index) * VARIANT_SIZE, arg));
        putU32s(block, [rgvarg, 0, count, 0]);
        for (const sink of sinks)
        {
            const hr = await method(thread, sink, SLOT_INVOKE, [dispid, block + 16, 0,
                DISPATCH_METHOD, block, 0, 0, 0]);
            if (hr !== S_OK && hr !== S_FALSE)
            {
                sayOnce('DWebBrowserEvents2', `a sink's Invoke of ${dispid} answered`
                    + ` 0x${hr.toString(16)}`);
            }
        }
        const after = args.map((arg, index)=>(byReference[index] !== 0
            && arg.vt !== (VT_BYREF | VT_VARIANT) ? u32(byReference[index]) & 0xffff
            : values[index]));
        strings.forEach(freeBstr);
        cells.forEach(cell=>host.heap.free(cell));
        host.heap.free(block);
        return after;
    };

    /**
     * The ready state, and IPropertyNotifySink told of a change.
     *
     * @param {any} object @param {number} state @param {unknown} thread
     */
    const setReadyState = async(object, state, thread)=>{
        if (object.state.readyState === state)
        {
            return;
        }
        object.state.readyState = state;
        for (const sink of object.state.sinks.get(IID_IPROPERTY_NOTIFY_SINK)?.values() ?? [])
        {
            await method(thread, sink, SLOT_ON_CHANGED, [DISPID.READYSTATE]);
        }
    };

    /** The control's IDispatch, as the events name the browser they come from. @param {any} object */
    const selfDispatch = object=>host.vtables.publish(object, INTERFACES.IWebBrowser2.iid) >>> 0;

    /**
     * An address as IE keeps it: a path on a drive as a file URL; anything
     * else as it was given.
     *
     * @param {string} url
     */
    const canonical = url=>(/^[a-z]:[\\/]/i.test(url)
        ? `file:///${url.replace(/\\/g, '/')}` : url);

    /**
     * The status text, to the sinks and to the frame's status bar.
     *
     * @param {any} object @param {string} text @param {unknown} thread
     */
    const statusText = async(object, text, thread)=>{
        object.state.statusText = text;
        await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.STATUSTEXTCHANGE, [
            { vt: VT_BSTR, text }], thread);
        if (object.state.frame !== 0)
        {
            const at = keptWide(text);
            await method(thread, object.state.frame, IN_PLACE_FRAME.SetStatusText, [at]);
            host.heap.free(at);
        }
    };

    /**
     * Whether Back and Forward can go anywhere, to the sinks.
     *
     * @param {any} object @param {unknown} thread
     */
    const commandStates = async(object, thread)=>{
        const { state } = object;
        for (const [command, enabled] of [[CSC_NAVIGATEBACK, state.at > 0],
            [CSC_NAVIGATEFORWARD, state.at + 1 < state.history.length]])
        {
            await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.COMMANDSTATECHANGE, [
                { vt: VT_I4, value: Number(command) },
                { vt: VT_BOOL, value: enabled ? VARIANT_TRUE : 0 }], thread);
        }
    };

    /**
     * Whether the site says it runs (DISPID_AMBIENT_USERMODE), asked as IE
     * asks it at a navigation; its answer changes nothing here.
     *
     * @param {any} object @param {unknown} thread
     */
    const askUserMode = async(object, thread)=>{
        const dispatch = object.state.clientSite === 0 ? 0
            : await query(thread, object.state.clientSite, IID_IDISPATCH);
        if (dispatch !== 0)
        {
            await ambientFlag(thread, dispatch, DISPID_AMBIENT.USERMODE);
            await method(thread, dispatch, SLOT_RELEASE, []);
        }
    };

    /**
     * The download's state to the container's command target, if it has
     * one: whether it was told.
     *
     * @param {any} object @param {number} downloading  1 or 0 @param {unknown} thread
     */
    const downloadState = async(object, downloading, thread)=>{
        const target = object.state.commandTarget;
        const variant = target === 0 ? 0 : allocate(VARIANT_SIZE);
        if (variant === 0)
        {
            return false;
        }
        putU16(variant, VT_I4);
        putU32s(variant + 8, [downloading]);
        await method(thread, target, SLOT_EXEC, [0, OLECMDID_SETDOWNLOADSTATE, 0, variant, 0]);
        host.heap.free(variant);
        return true;
    };

    /**
     * A navigation as IE makes one: loading, BeforeNavigate2 (a sink may
     * cancel), then the download begun and done at once (there is nothing
     * to fetch it with); NavigateComplete2 and DocumentComplete come later
     * from the control window's message loop, or at once without a window.
     *
     * @param {any} object @param {string} asked @param {unknown} thread
     * @param {{ history?: boolean }} [how]
     */
    const navigate = async(object, asked, thread, how = {})=>{
        const url = canonical(asked);
        const { state } = object;
        const self = selfDispatch(object);
        await askUserMode(object, thread);
        state.busy = false;
        await setReadyState(object, READYSTATE_LOADING, thread);
        const [, , , , , , cancel] = await fire(object, DIID_DWEB_BROWSER_EVENTS2,
            DISPID.BEFORENAVIGATE2, [
                { vt: VT_DISPATCH, value: self },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_BSTR, text: url } },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_I4, value: 0 } },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_BSTR, text: null } },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_BYREF | VT_VARIANT,
                    inner: { vt: 0 } } },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_BSTR, text: null } },
                { vt: VT_BYREF | VT_BOOL, value: 0 },
            ], thread);
        const [, , , , , cancelV1] = await fire(object, DIID_DWEB_BROWSER_EVENTS,
            DISPID.BEFORENAVIGATE, [
                { vt: VT_BSTR, text: url }, { vt: VT_I4, value: 0 }, { vt: VT_BSTR, text: null },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: 0 } }, { vt: VT_BSTR, text: null },
                { vt: VT_BYREF | VT_BOOL, value: 0 },
            ], thread);
        if (cancel !== 0 || cancelV1 !== 0)
        {
            return S_OK;
        }
        if (how.history !== false)
        {
            state.history.splice(state.at + 1, Infinity, url);
            state.at = state.history.length - 1;
        }
        state.busy = true;
        await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.DOWNLOADBEGIN, [], thread);
        await downloadState(object, 1, thread);
        if (state.frame !== 0)
        {
            await method(thread, state.frame, IN_PLACE_FRAME.EnableModeless, [0]);
        }
        await statusText(object, '', thread);
        await commandStates(object, thread);
        if (state.frame !== 0)
        {
            await method(thread, state.frame, IN_PLACE_FRAME.EnableModeless, [1]);
        }
        state.busy = false;
        if (!await downloadState(object, 0, thread))
        {
            await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.DOWNLOADCOMPLETE, [], thread);
        }
        state.pending.push(url);
        if (state.hwnd !== 0)
        {
            await host.system('USER32.dll', 'PostMessageW', [state.hwnd, WM_BROWSER_NAVIGATED,
                0, 0], thread);
            return S_OK;
        }
        await finishNavigations(object, thread);
        return S_OK;
    };

    /**
     * What IE tells once a page has arrived: the navigation complete, the
     * title, the document complete. The page itself is not drawn.
     *
     * @param {any} object @param {unknown} thread
     */
    const finishNavigations = async(object, thread)=>{
        const { state } = object;
        while (state.pending.length > 0)
        {
            const url = state.pending.shift();
            const self = selfDispatch(object);
            sayOnce('IWebBrowser2', `the page at ${url} is not drawn: there is no HTML engine`,
                'loss');
            state.location = url;
            state.title = url;
            await setReadyState(object, READYSTATE_INTERACTIVE, thread);
            await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.NAVIGATECOMPLETE2, [
                { vt: VT_DISPATCH, value: self },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_BSTR, text: url } }], thread);
            await fire(object, DIID_DWEB_BROWSER_EVENTS, DISPID.NAVIGATECOMPLETE, [
                { vt: VT_BSTR, text: url }], thread);
            await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.TITLECHANGE, [
                { vt: VT_BSTR, text: url }], thread);
            await setReadyState(object, READYSTATE_COMPLETE, thread);
            await fire(object, DIID_DWEB_BROWSER_EVENTS2, DISPID.DOCUMENTCOMPLETE, [
                { vt: VT_DISPATCH, value: self },
                { vt: VT_BYREF | VT_VARIANT, inner: { vt: VT_BSTR, text: url } }], thread);
        }
    };

    /** The URL a Navigate2 VARIANT carries: a BSTR, by value or by reference. @param {number} at */
    const urlOfVariant = at=>{
        if ((at >>> 0) === 0)
        {
            return null;
        }
        let vt = u32(at) & 0xffff;
        let value = u32(at + 8);
        if (vt === (VT_BYREF | VT_VARIANT))
        {
            vt = u32(value) & 0xffff;
            value = u32(value + 8);
        }
        if (vt === (VT_BYREF | VT_BSTR))
        {
            return wideAt(u32(value));
        }
        return vt === VT_BSTR ? wideAt(value) : null;
    };

    /**
     * The control's windows in a parent window, the outer one hidden at no
     * size: IE makes them as soon as it has a site, so a navigation has a
     * message loop to finish from before the control is shown.
     *
     * @param {any} object @param {number} parent @param {unknown} thread
     */
    const createWindows = async(object, parent, thread)=>{
        if (classNames.length === 0)
        {
            classNames = BROWSER_CLASSES.map(keptWide);
            emptyName = keptWide('');
        }
        /** @type {number[]} */
        const made = [];
        let owner = parent;
        for (const [index, name] of classNames.entries())
        {
            const style = index > 0 ? WS_CHILD | WS_CLIP | WS_VISIBLE
                : (parent === 0 ? WS_POPUP : WS_CHILD) | WS_CLIP;
            const hwnd = Number(await host.system('USER32.dll', 'CreateWindowExW', [0, name,
                emptyName, style >>> 0, 0, 0, 0, 0, owner, 0, 0, 0], thread) ?? 0) >>> 0;
            if (hwnd === 0)
            {
                host.divergence?.('IOleObject::SetClientSite', `the ${BROWSER_CLASSES[index]}`
                    + ' window was not made', 'loss');
                break;
            }
            byWindow.set(hwnd, object);
            made.push(hwnd);
            owner = hwnd;
        }
        object.state.windows = made;
        object.state.hwnd = made[0] ?? 0;
        return object.state.hwnd;
    };

    /**
     * The windows gone, with the navigations they would have finished.
     *
     * @param {any} object @param {unknown} thread
     */
    const destroyWindows = async(object, thread)=>{
        const { state } = object;
        const outer = state.hwnd;
        for (const hwnd of state.windows)
        {
            byWindow.delete(hwnd);
        }
        state.windows = [];
        state.hwnd = 0;
        if (outer !== 0)
        {
            await host.system('USER32.dll', 'DestroyWindow', [outer], thread);
        }
    };

    /**
     * The windows moved to a rectangle in the site's window.
     *
     * @param {any} object @param {number[]} rect @param {unknown} thread
     */
    const placeWindows = async(object, rect, thread)=>{
        const [left, top, right, bottom] = rect;
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        for (const [index, hwnd] of object.state.windows.entries())
        {
            await host.system('USER32.dll', 'MoveWindow', [hwnd, index === 0 ? left : 0,
                index === 0 ? top : 0, width, height, 1], thread);
        }
    };

    /**
     * What a site's method writes out, read, and the reference it took
     * released when it is an interface: the container, the frame's window.
     *
     * @param {unknown} thread @param {number} pointer @param {number} slot
     * @param {boolean} release
     */
    const askOut = async(thread, pointer, slot, release)=>{
        const cell = pointer === 0 ? 0 : allocate(4);
        if (cell === 0)
        {
            return 0;
        }
        const hr = await method(thread, pointer, slot, [cell]);
        const out = hr === S_OK ? u32(cell) : 0;
        host.heap.free(cell);
        if (release && out !== 0)
        {
            await method(thread, out, SLOT_RELEASE, []);
        }
        return out;
    };

    /**
     * An ambient property of the site as a VARIANT_BOOL, or null when the
     * site does not answer it.
     *
     * @param {unknown} thread @param {number} dispatch @param {number} dispid
     */
    const ambientFlag = async(thread, dispatch, dispid)=>{
        // DISPPARAMS with no arguments, IID_NULL, then the result VARIANT, empty.
        const block = allocate(16 + 16 + VARIANT_SIZE);
        if (block === 0)
        {
            return null;
        }
        const hr = await method(thread, dispatch, SLOT_INVOKE, [dispid, block + 16, 0,
            DISPATCH_PROPERTYGET, block, block + 32, 0, 0]);
        const vt = u32(block + 32) & 0xffff;
        const value = u32(block + 40) & 0xffff;
        host.heap.free(block);
        return hr === S_OK && vt === VT_BOOL ? value !== 0 : null;
    };

    /** The ambient properties IE follows, and the property each sets. */
    const AMBIENT_FLAGS = /** @type {[number, string][]} */ ([
        [DISPID_AMBIENT.OFFLINEIFNOTCONNECTED, 'Offline'], [DISPID_AMBIENT.SILENT, 'Silent']]);

    /**
     * The site's ambient properties read, each into the property it sets.
     *
     * @param {any} object @param {unknown} thread @param {[number, string][]} which
     */
    const readAmbients = async(object, thread, which)=>{
        const dispatch = object.state.clientSite === 0 || which.length === 0 ? 0
            : await query(thread, object.state.clientSite, IID_IDISPATCH);
        if (dispatch === 0)
        {
            return;
        }
        for (const [dispid, key] of which)
        {
            const flag = await ambientFlag(thread, dispatch, dispid);
            if (flag !== null)
            {
                object.state.flags[key] = flag;
            }
        }
        await method(thread, dispatch, SLOT_RELEASE, []);
    };

    /**
     * The client site taken: its window found and the control's windows
     * made in it, its container asked for, the ambient properties a browser
     * follows (offline, silent) read.
     *
     * @param {any} object @param {number} site @param {unknown} thread
     */
    const takeSite = async(object, site, thread)=>{
        const { state } = object;
        sessions++;
        const window = await query(thread, site, IID_IOLE_WINDOW);
        const parent = await askOut(thread, window, IN_PLACE_SITE.GetWindow, false);
        if (window !== 0)
        {
            await method(thread, window, SLOT_RELEASE, []);
        }
        if (state.hwnd === 0)
        {
            await createWindows(object, parent, thread);
        }
        else if (parent !== 0 && parent !== state.parent)
        {
            await host.system('USER32.dll', 'SetParent', [state.hwnd, parent], thread);
        }
        state.parent = parent || state.parent;
        // IE tells the download's state to its container's command target when
        // it has one, and DownloadComplete to its sinks when not.
        const container = await askOut(thread, site, CLIENT_SITE.GetContainer, false);
        if (container !== 0)
        {
            state.commandTarget = await query(thread, container, IID_IOLE_COMMAND_TARGET);
            await method(thread, container, SLOT_RELEASE, []);
        }
        state.busy ??= false;
        await readAmbients(object, thread, AMBIENT_FLAGS);
        if (state.pending.length > 0 && state.hwnd !== 0)
        {
            await host.system('USER32.dll', 'PostMessageW', [state.hwnd, WM_BROWSER_NAVIGATED,
                0, 0], thread);
        }
    };

    /**
     * In-place activation through the site: asked whether it may, told it
     * is, its window and rectangles read, the windows moved there and shown;
     * UI activation then makes the control the frame's active object.
     *
     * @param {any} object @param {number} site  an IOleClientSite
     * @param {number} rectGiven @param {boolean} ui @param {unknown} thread
     */
    const activate = async(object, site, rectGiven, ui, thread)=>{
        const { state } = object;
        if (state.inPlaceSite === 0)
        {
            const inPlace = await query(thread, site, IID_IOLE_IN_PLACE_SITE);
            if (inPlace === 0)
            {
                return E_NOINTERFACE;
            }
            if (await method(thread, inPlace, IN_PLACE_SITE.CanInPlaceActivate, []) !== S_OK)
            {
                await method(thread, inPlace, SLOT_RELEASE, []);
                return E_FAIL;
            }
            state.inPlaceSite = inPlace;
            const parent = await askOut(thread, inPlace, IN_PLACE_SITE.GetWindow, false);
            await method(thread, inPlace, IN_PLACE_SITE.OnInPlaceActivate, []);
            const block = allocate(4 + 4 + 16 + 16 + 20);
            if (block === 0)
            {
                return E_OUTOFMEMORY;
            }
            // OLEINPLACEFRAMEINFO's cb is the caller's to fill.
            putU32s(block + 40, [20]);
            await method(thread, inPlace, IN_PLACE_SITE.GetWindowContext, [block, block + 4,
                block + 8, block + 24, block + 40]);
            state.frame = u32(block);
            state.document = u32(block + 4);
            // The site's own position rectangle, as IE places itself; the verb's
            // when the site leaves it empty.
            const pos = [8, 12, 16, 20].map(offset=>u32(block + offset) | 0);
            const rect = pos[2] > pos[0] || pos[3] > pos[1] || (rectGiven >>> 0) === 0 ? pos
                : [0, 4, 8, 12].map(offset=>u32(rectGiven + offset) | 0);
            host.heap.free(block);
            if (state.hwnd === 0)
            {
                await createWindows(object, parent, thread);
            }
            else if (parent !== 0 && parent !== state.parent)
            {
                await host.system('USER32.dll', 'SetParent', [state.hwnd, parent], thread);
            }
            state.parent = parent || state.parent;
            await placeWindows(object, rect, thread);
            if (state.hwnd !== 0)
            {
                await host.system('USER32.dll', 'ShowWindow', [state.hwnd, SW_SHOW], thread);
            }
            if (state.clientSite !== 0)
            {
                await method(thread, state.clientSite, CLIENT_SITE.ShowObject, []);
                await askOut(thread, state.clientSite, CLIENT_SITE.GetContainer, true);
            }
            await askOut(thread, state.frame, IN_PLACE_FRAME.GetWindow, false);
        }
        if (ui && !state.uiActive)
        {
            state.uiActive = true;
            await method(thread, state.inPlaceSite, IN_PLACE_SITE.OnUIActivate, []);
            const active = host.vtables.publish(object, INTERFACES.IOleInPlaceActiveObject.iid)
                >>> 0;
            for (const window of [state.frame, state.document])
            {
                if (window !== 0)
                {
                    await method(thread, window, IN_PLACE_FRAME.SetActiveObject, [active,
                        itemName()]);
                }
            }
            if (state.frame !== 0)
            {
                await method(thread, state.frame, IN_PLACE_FRAME.SetMenu, [0, 0, state.hwnd]);
            }
            const control = state.clientSite === 0 ? 0
                : await query(thread, state.clientSite, IID_IOLE_CONTROL_SITE);
            if (control !== 0)
            {
                await method(thread, control, CONTROL_SITE.OnFocus, [1]);
                await method(thread, control, SLOT_RELEASE, []);
            }
        }
        return S_OK;
    };

    /**
     * UI deactivation: the frame and document window let go of the control.
     *
     * @param {any} object @param {unknown} thread
     */
    const uiDeactivate = async(object, thread)=>{
        const { state } = object;
        if (!state.uiActive || state.inPlaceSite === 0)
        {
            return;
        }
        state.uiActive = false;
        for (const window of [state.frame, state.document])
        {
            if (window !== 0)
            {
                await method(thread, window, IN_PLACE_FRAME.SetActiveObject, [0, 0]);
            }
        }
        await method(thread, state.inPlaceSite, IN_PLACE_SITE.OnUIDeactivate, [0]);
    };

    /**
     * In-place deactivation: the site told, the windows hidden (they stay
     * until the site goes), the frame and document window let go of.
     *
     * @param {any} object @param {unknown} thread
     */
    const deactivate = async(object, thread)=>{
        const { state } = object;
        if (state.inPlaceSite === 0)
        {
            return S_OK;
        }
        await uiDeactivate(object, thread);
        const site = state.inPlaceSite;
        state.inPlaceSite = 0;
        if (state.hwnd !== 0)
        {
            await host.system('USER32.dll', 'ShowWindow', [state.hwnd, SW_HIDE], thread);
        }
        for (const window of [state.frame, state.document])
        {
            if (window !== 0)
            {
                await method(thread, window, SLOT_RELEASE, []);
            }
        }
        state.frame = 0;
        state.document = 0;
        await method(thread, site, IN_PLACE_SITE.OnInPlaceDeactivate, []);
        await method(thread, site, SLOT_RELEASE, []);
        return S_OK;
    };

    /**
     * EnumVerbs' enumerator, as IE's behaves: each Next hands out one verb
     * whatever count was asked for and says it fetched none, and Skip moves
     * nothing; past the last verb Next answers S_FALSE.
     */
    const verbList = ()=>{
        let index = 0;
        /** @param {any} _ @param {number[]} args */
        const next = (_, [, verbs, fetched])=>{
            if ((fetched >>> 0) !== 0)
            {
                putU32s(fetched, [0]);
            }
            if (index >= VERBS.length)
            {
                return S_FALSE;
            }
            if ((verbs >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32s(verbs, [VERBS[index++], 0, 0, 0]);
            return S_OK;
        };
        return createComObject(IID_IENUM_OLEVERB, { interfaces: [{
            id: IID_IENUM_OLEVERB,
            methods: [
                { name: 'Next', argBytes: 16, invoke: next },
                { name: 'Skip', argBytes: 8, invoke: ()=>S_OK },
                { name: 'Reset', argBytes: 4, invoke: ()=>((index = 0), S_OK) },
                { name: 'Clone', argBytes: 8, invoke: ()=>{
                    sayOnce('IEnumOLEVERB::Clone', 'not answered: E_NOTIMPL');
                    return E_NOTIMPL;
                } },
            ],
        }] });
    };

    /** @param {number} out @param {number} value */
    const answer = (out, value)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        putU32s(out, [value]);
        return S_OK;
    };
    /** @param {number} out @param {string} text  S_FALSE with an empty string, as IE answers. */
    const answerText = (out, text)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        const made = bstr(text);
        if (made === 0)
        {
            return E_OUTOFMEMORY;
        }
        putU32s(out, [made]);
        return text === '' ? S_FALSE : S_OK;
    };
    /** A VARIANT_BOOL property: kept as given, -1 or 0 read back. */
    const flagProperty = (/** @type {string} */ key, /** @type {number} */ dispid = 0)=>({
        [`get_${key}`]: (/** @type {any} */ object, /** @type {number[]} */ [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU16(out, object.state.flags[key] ? VARIANT_TRUE : 0);
            return S_OK;
        },
        [`put_${key}`]: async(/** @type {any} */ object, /** @type {number[]} */ [value])=>{
            object.state.flags[key] = (value & 0xffff) !== 0;
            if (dispid !== 0)
            {
                await fire(object, DIID_DWEB_BROWSER_EVENTS2, dispid, [
                    { vt: VT_BOOL, value: object.state.flags[key] ? VARIANT_TRUE : 0 }],
                host.callerThread());
            }
            return S_OK;
        },
    });

    /** @type {Record<string, Record<string, (object: any, args: number[]) => any>>} */
    const IMPL = {
        IWebBrowser2: {
            GetTypeInfoCount: (_, [out])=>answer(out, 0),
            GoBack: object=>{
                const { state } = object;
                if (state.at <= 0)
                {
                    return E_FAIL;
                }
                state.at--;
                return navigate(object, state.history[state.at], host.callerThread(),
                    { history: false });
            },
            GoForward: object=>{
                const { state } = object;
                if (state.at + 1 >= state.history.length)
                {
                    return E_FAIL;
                }
                state.at++;
                return navigate(object, state.history[state.at], host.callerThread(),
                    { history: false });
            },
            GoHome: object=>navigate(object, 'about:blank', host.callerThread()),
            GoSearch: object=>navigate(object, 'about:blank', host.callerThread()),
            Navigate: (object, [url])=>((url >>> 0) === 0 ? S_FALSE
                : navigate(object, wideAt(url), host.callerThread())),
            Navigate2: (object, [url])=>{
                const text = urlOfVariant(url);
                return text === null ? E_INVALIDARG : navigate(object, text, host.callerThread());
            },
            Refresh: object=>(object.state.location === '' ? S_OK
                : navigate(object, object.state.location, host.callerThread(), { history: false })),
            Refresh2: object=>(object.state.location === '' ? S_OK
                : navigate(object, object.state.location, host.callerThread(), { history: false })),
            Stop: object=>{
                object.state.pending.length = 0;
                object.state.busy = false;
                return S_OK;
            },
            get_Application: (object, [out])=>answer(out, (object.addRef(), selfDispatch(object))),
            get_Parent: (object, [out])=>answer(out, (object.addRef(), selfDispatch(object))),
            get_Container: (_, [out])=>answer(out, 0),
            get_Document: (object, [out])=>{
                if (object.state.location !== '')
                {
                    sayOnce('IWebBrowser2::get_Document', 'the page has no document: there is no'
                        + ' HTML engine', 'loss');
                }
                return answer(out, 0);
            },
            get_TopLevelContainer: (_, [out])=>((out >>> 0) === 0 ? E_POINTER
                : (putU16(out, VARIANT_TRUE), S_OK)),
            get_Type: (_, [out])=>answerText(out, ''),
            get_Left: (object, [out])=>answer(out, object.state.bounds[0]),
            put_Left: (object, [value])=>((object.state.bounds[0] = value | 0), S_OK),
            get_Top: (object, [out])=>answer(out, object.state.bounds[1]),
            put_Top: (object, [value])=>((object.state.bounds[1] = value | 0), S_OK),
            get_Width: (object, [out])=>answer(out, object.state.bounds[2]),
            put_Width: (object, [value])=>((object.state.bounds[2] = value | 0), S_OK),
            get_Height: (object, [out])=>answer(out, object.state.bounds[3]),
            put_Height: (object, [value])=>((object.state.bounds[3] = value | 0), S_OK),
            get_LocationName: (object, [out])=>answerText(out, object.state.title),
            get_LocationURL: (object, [out])=>answerText(out, object.state.location),
            get_Busy: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (object.state.busy === null)
                {
                    return E_FAIL;
                }
                putU16(out, object.state.busy ? VARIANT_TRUE : 0);
                return S_OK;
            },
            Quit: ()=>E_FAIL,
            get_Name: (_, [out])=>answerText(out, 'Microsoft Web Browser Control'),
            get_HWND: (_, [out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32s(out, [0]);
                }
                return E_FAIL;
            },
            get_FullName: (_, [out])=>answerText(out, ''),
            get_Path: (_, [out])=>answerText(out, ''),
            ...flagProperty('Visible', 254),
            ...flagProperty('StatusBar', 257),
            ...flagProperty('ToolBar', 255),
            ...flagProperty('MenuBar', 256),
            ...flagProperty('FullScreen', 258),
            ...flagProperty('Offline'),
            ...flagProperty('Silent'),
            ...flagProperty('RegisterAsBrowser'),
            ...flagProperty('RegisterAsDropTarget'),
            ...flagProperty('TheaterMode', 260),
            ...flagProperty('AddressBar', 261),
            ...flagProperty('Resizable', 262),
            get_StatusText: (object, [out])=>answerText(out, object.state.statusText),
            put_StatusText: (object, [text])=>((object.state.statusText = wideAt(text)), S_OK),
            get_ReadyState: (object, [out])=>answer(out, object.state.readyState),
            // A command goes to the page's document, and there is none: IE answers
            // E_UNEXPECTED while it has no document, and leaves the status as it was.
            QueryStatusWB: ()=>E_UNEXPECTED,
            ExecWB: ()=>E_UNEXPECTED,
        },
        IOleObject: {
            SetClientSite: async(object, [site])=>{
                const thread = host.callerThread();
                const { state } = object;
                if ((site >>> 0) === state.clientSite)
                {
                    return S_OK;
                }
                const old = state.clientSite;
                if (old !== 0)
                {
                    await deactivate(object, thread);
                    sessions = Math.max(0, sessions - 1);
                }
                if ((site >>> 0) === 0)
                {
                    await destroyWindows(object, thread);
                }
                else
                {
                    await method(thread, site, SLOT_ADDREF, []);
                }
                state.clientSite = site >>> 0;
                if (state.commandTarget !== 0)
                {
                    await method(thread, state.commandTarget, SLOT_RELEASE, []);
                    state.commandTarget = 0;
                }
                if (old !== 0)
                {
                    await method(thread, old, SLOT_RELEASE, []);
                }
                if (state.clientSite !== 0)
                {
                    await takeSite(object, state.clientSite, thread);
                }
                return S_OK;
            },
            GetClientSite: async(object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (object.state.clientSite !== 0)
                {
                    await method(host.callerThread(), object.state.clientSite, SLOT_ADDREF, []);
                }
                putU32s(out, [object.state.clientSite]);
                return S_OK;
            },
            SetHostNames: ()=>S_OK,
            Close: object=>deactivate(object, host.callerThread()),
            DoVerb: async(object, [verb, , site, , , rect])=>{
                const thread = host.callerThread();
                const given = (site >>> 0) || object.state.clientSite;
                switch (verb | 0){
                    case OLEIVERB_SHOW:
                    case OLEIVERB_PRIMARY:
                    case OLEIVERB_OPEN:
                    case OLEIVERB_UIACTIVATE:
                    case OLEIVERB_INPLACEACTIVATE:
                    {
                        if (given === 0)
                        {
                            return E_INVALIDARG;
                        }
                        return activate(object, given, rect >>> 0,
                            (verb | 0) !== OLEIVERB_INPLACEACTIVATE, thread);
                    }
                    case OLEIVERB_HIDE:
                        if (object.state.hwnd !== 0)
                        {
                            await host.system('USER32.dll', 'ShowWindow', [object.state.hwnd,
                                SW_HIDE], thread);
                        }
                        return S_OK;
                    default:
                        return E_NOTIMPL;
                }
            },
            EnumVerbs: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                putU32s(out, [host.vtables.publish(verbList(), IID_IENUM_OLEVERB)]);
                return S_OK;
            },
            Update: ()=>S_OK,
            IsUpToDate: ()=>S_OK,
            GetUserClassID: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(object.state.v1
                    ? CLSID_WEB_BROWSER_V1 : CLSID_WEB_BROWSER)));
                return S_OK;
            },
            SetExtent: (object, [, size])=>{
                if ((size >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                object.state.extent = [u32(size) | 0, u32(size + 4) | 0];
                return S_OK;
            },
            GetExtent: (object, [, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                putU32s(out, object.state.extent);
                return S_OK;
            },
            Advise: async(object, [sink, cookie])=>{
                if ((sink >>> 0) === 0 || (cookie >>> 0) === 0)
                {
                    if ((cookie >>> 0) !== 0)
                    {
                        putU32s(cookie, [0]);
                    }
                    return E_INVALIDARG;
                }
                await method(host.callerThread(), sink, SLOT_ADDREF, []);
                const id = ++object.state.nextCookie;
                object.state.adviseSinks.set(id, sink >>> 0);
                putU32s(cookie, [id]);
                return S_OK;
            },
            Unadvise: async(object, [cookie])=>{
                const sink = object.state.adviseSinks.get(cookie >>> 0);
                if (sink === undefined)
                {
                    return OLE_E_NOCONNECTION;
                }
                object.state.adviseSinks.delete(cookie >>> 0);
                await method(host.callerThread(), sink, SLOT_RELEASE, []);
                return S_OK;
            },
            // IE keeps no list of its advise sinks to enumerate.
            EnumAdvise: (_, [out])=>((out >>> 0) === 0 ? E_INVALIDARG
                : (putU32s(out, [0]), E_NOTIMPL)),
            GetMiscStatus: (_, [, out])=>answer(out, MISC_STATUS),
            SetColorScheme: ()=>E_NOTIMPL,
        },
        IOleInPlaceObject: {
            GetWindow: (object, [out])=>((out >>> 0) === 0 ? E_INVALIDARG
                : (putU32s(out, [object.state.hwnd]), S_OK)),
            ContextSensitiveHelp: ()=>E_NOTIMPL,
            InPlaceDeactivate: object=>deactivate(object, host.callerThread()),
            UIDeactivate: async object=>{
                await uiDeactivate(object, host.callerThread());
                return S_OK;
            },
            SetObjectRects: async(object, [pos])=>{
                if ((pos >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                await placeWindows(object, [0, 4, 8, 12].map(offset=>u32(pos + offset) | 0),
                    host.callerThread());
                return S_OK;
            },
            ReactivateAndUndo: ()=>E_NOTIMPL,
        },
        IOleInPlaceActiveObject: {
            GetWindow: (object, [out])=>((out >>> 0) === 0 ? E_INVALIDARG
                : (putU32s(out, [object.state.hwnd]), S_OK)),
            ContextSensitiveHelp: ()=>E_NOTIMPL,
            TranslateAccelerator: ()=>S_FALSE,
            OnFrameWindowActivate: ()=>S_OK,
            OnDocWindowActivate: ()=>S_OK,
            ResizeBorder: ()=>S_OK,
            EnableModeless: ()=>S_OK,
        },
        IOleControl: {
            GetControlInfo: ()=>E_NOTIMPL,
            OnMnemonic: ()=>E_NOTIMPL,
            // Only a property named is read again: IE reads none for DISPID_UNKNOWN.
            OnAmbientPropertyChange: async(object, [dispid])=>{
                await readAmbients(object, host.callerThread(), AMBIENT_FLAGS
                    .filter(([known])=>known === (dispid | 0)));
                return S_OK;
            },
            FreezeEvents: ()=>S_OK,
        },
        IViewObject2: {
            SetAdvise: (object, [, , sink])=>((object.state.viewAdvise = sink >>> 0), S_OK),
            GetAdvise: (object, [aspects, flags, out])=>{
                for (const [at, value] of [[aspects, 0], [flags, 0], [out, 0]])
                {
                    if ((at >>> 0) !== 0)
                    {
                        putU32s(at, [value]);
                    }
                }
                return S_OK;
            },
        },
        IPersistStreamInit: {
            GetClassID: (object, [out])=>IMPL.IOleObject.GetUserClassID(object, [out]),
            IsDirty: ()=>S_FALSE,
            InitNew: ()=>S_OK,
            Load: ()=>S_OK,
        },
        IPersistStorage: {
            GetClassID: (object, [out])=>IMPL.IOleObject.GetUserClassID(object, [out]),
            IsDirty: ()=>S_FALSE,
            InitNew: ()=>S_OK,
            Load: ()=>S_OK,
            SaveCompleted: ()=>S_OK,
            HandsOffStorage: ()=>S_OK,
        },
        IProvideClassInfo2: {
            GetClassInfo: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const info = object.state.v1
                    ? classInfo(CLSID_WEB_BROWSER_V1, 'WebBrowser_V1', 'WebBrowser Control')
                    : classInfo(CLSID_WEB_BROWSER, 'WebBrowser', 'WebBrowser Control');
                putU32s(out, [host.vtables.publish(info, IID_ITYPEINFO)]);
                return S_OK;
            },
            GetGUID: (object, [kind, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((kind >>> 0) !== GUIDKIND_DEFAULT_SOURCE_DISP_IID)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(16));
                    return E_FAIL;
                }
                host.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(object.state.v1
                    ? DIID_DWEB_BROWSER_EVENTS : DIID_DWEB_BROWSER_EVENTS2)));
                return S_OK;
            },
        },
        IConnectionPointContainer: {
            FindConnectionPoint: (object, [iid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                putU32s(out, [0]);
                const key = canonicalGuid(formatAt(iid));
                const point = key === null ? undefined : pointOf(object, key);
                if (!point)
                {
                    return CONNECT_E_NOCONNECTION;
                }
                const pointer = host.vtables.publish(point, CONNECTION_POINT.iid) >>> 0;
                point.addRef();
                putU32s(out, [pointer]);
                return S_OK;
            },
        },
        IServiceProvider: {
            QueryService: (_, [, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32s(out, [0]);
                }
                return E_NOINTERFACE;
            },
        },
        IOleCommandTarget: {
            // No group's commands are known while there is no document.
            QueryStatus: ()=>OLECMDERR_E_UNKNOWNGROUP,
            Exec: ()=>E_UNEXPECTED,
        },
    };

    /** A GUID in guest memory as text. @param {number} at */
    const formatAt = at=>{
        const raw = host.readMemory(at >>> 0, 16);
        const view = new DataView(raw.buffer, raw.byteOffset, 16);
        const hex = (/** @type {number} */ v, /** @type {number} */ n)=>v.toString(16)
            .padStart(n, '0');
        const tail = [...raw.subarray(8)].map(b=>hex(b, 2)).join('');
        return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
            + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
    };

    /**
     * An interface's methods as the bridge takes them: each one's own
     * implementation, or a refusal said once.
     *
     * @param {string} name @param {import('./layout.js').BrowserInterface} layout
     * @param {Record<string, (object: any, args: number[]) => any>} impl
     */
    const descriptor = (name, layout, impl)=>({
        id: /** @type {string} */ (canonicalGuid(layout.iid)),
        methods: layout.methods.map(([methodName, argBytes])=>({
            name: methodName, argBytes,
            invoke: impl[methodName] ?? (()=>{
                sayOnce(`${name}::${methodName}`, 'not answered: E_NOTIMPL');
                return E_NOTIMPL;
            }),
        })),
    });
    // An alias (IDispatch, IWebBrowser, IWebBrowserApp, IOleWindow, IViewObject,
    // IPersist, IProvideClassInfo) answers with its base's methods: COM asks
    // the same object of each, and only IUnknown's pointer is its identity.
    const DESCRIPTORS = Object.entries(INTERFACES).flatMap(([name, layout])=>{
        const base = descriptor(name, layout, IMPL[name] ?? {});
        return [base, ...(layout.aliases ?? []).map(id=>({
            id: /** @type {string} */ (canonicalGuid(id)), methods: base.methods }))];
    });

    /**
     * An event source of the control: the sinks advised on it, each its
     * dispatch interface (or IDispatch) held.
     *
     * @param {any} control @param {string} iid
     */
    const connectionPoint = (control, iid)=>{
        /** @type {Map<number, number>} */
        const sinks = new Map();
        let cookies = 0;
        control.state.sinks.set(iid, sinks);
        const point = createComObject(CONNECTION_POINT.iid, {
            interfaces: [descriptor('IConnectionPoint', CONNECTION_POINT, {
                GetConnectionInterface: (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    host.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(iid)));
                    return S_OK;
                },
                GetConnectionPointContainer: (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    control.addRef();
                    putU32s(out, [host.vtables.publish(control,
                        INTERFACES.IConnectionPointContainer.iid)]);
                    return S_OK;
                },
                Advise: async(_, [sink, cookie])=>{
                    if ((sink >>> 0) === 0 || (cookie >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const thread = host.callerThread();
                    const held = await query(thread, sink, iid)
                        || (iid === IID_IPROPERTY_NOTIFY_SINK ? 0
                            : await query(thread, sink, IID_IDISPATCH));
                    if (held === 0)
                    {
                        return CONNECT_E_CANNOTCONNECT;
                    }
                    const id = ++cookies;
                    sinks.set(id, held);
                    putU32s(cookie, [id]);
                    return S_OK;
                },
                Unadvise: async(_, [cookie])=>{
                    const held = sinks.get(cookie >>> 0);
                    if (held === undefined)
                    {
                        return CONNECT_E_NOCONNECTION;
                    }
                    sinks.delete(cookie >>> 0);
                    await method(host.callerThread(), held, SLOT_RELEASE, []);
                    return S_OK;
                },
            })],
        });
        return point;
    };

    /** The event interfaces the control has a source for. */
    const SOURCES = [DIID_DWEB_BROWSER_EVENTS2, DIID_DWEB_BROWSER_EVENTS, IID_IPROPERTY_NOTIFY_SINK]
        .map(iid=>/** @type {string} */ (canonicalGuid(iid)));

    /**
     * The control's source for an event interface, made when first asked
     * and held for the control's life, or undefined for one it has not.
     *
     * @param {any} object @param {string} key
     */
    const pointOf = (object, key)=>{
        if (!SOURCES.includes(key))
        {
            return undefined;
        }
        let point = object.state.points.get(key);
        if (!point)
        {
            point = connectionPoint(object, key);
            object.state.points.set(key, point);
        }
        return point;
    };

    /**
     * A control of either class, as the COM registry makes it.
     *
     * @param {boolean} v1  the version 1 control, whose events are DWebBrowserEvents
     */
    const definition = v1=>({
        interfaces: DESCRIPTORS,
        state: {
            v1, clientSite: 0, inPlaceSite: 0, frame: 0, document: 0, commandTarget: 0, hwnd: 0,
            parent: 0,
            /** @type {number[]} */ windows: [],
            uiActive: false, location: '', title: '', statusText: '',
            readyState: READYSTATE_UNINITIALIZED, /** @type {boolean | null} */ busy: null,
            /** @type {string[]} */ history: [], at: -1, /** @type {string[]} */ pending: [],
            /** @type {Record<string, boolean>} */
            flags: { MenuBar: true, ToolBar: true, StatusBar: true, AddressBar: true,
                Resizable: true, Visible: false, FullScreen: false, Offline: false,
                Silent: false, RegisterAsBrowser: false, RegisterAsDropTarget: true,
                TheaterMode: false },
            bounds: [0, 0, 0, 0], extent: [1323, 529], nextCookie: 0,
            /** @type {Map<string, Map<number, number>>} */ sinks: new Map(),
            /** @type {Map<number, number>} */ adviseSinks: new Map(),
            /** @type {Map<string, any>} */ points: new Map(), viewAdvise: 0,
        },
    });

    return {
        definition,
        /**
         * SetQueryNetSessionCount: the count of browser sessions read, or
         * changed by one and read.
         *
         * @param {number} command  0 query, 1 increment, 2 decrement
         */
        sessionCount: command=>{
            if (command === 1)
            {
                sessions++;
            }
            else if (command === 2)
            {
                sessions = Math.max(0, sessions - 1);
            }
            return sessions;
        },
        /**
         * What the control's window does with the message it posts itself:
         * the navigations waiting finished, on the window's thread.
         *
         * @param {number} hwnd @param {unknown} thread
         * @returns {Promise<boolean>} whether the window is a control's
         */
        navigated: async(hwnd, thread)=>{
            const object = byWindow.get(hwnd >>> 0);
            if (!object)
            {
                return false;
            }
            await finishNavigations(object, thread);
            return true;
        },
    };
}
