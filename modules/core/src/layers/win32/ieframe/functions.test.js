/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';
import { createIeframe } from './functions.js';
import { WM_BROWSER_NAVIGATED } from './browser.js';
import {
    CLSID_WEB_BROWSER, CLSID_WEB_BROWSER_V1, DIID_DWEB_BROWSER_EVENTS,
    DIID_DWEB_BROWSER_EVENTS2, IID_IDISPATCH, IID_IOLE_COMMAND_TARGET, IID_IOLE_CONTROL_SITE,
    IID_IOLE_IN_PLACE_SITE, IID_IOLE_WINDOW, IID_IPROPERTY_NOTIFY_SINK, INTERFACES,
} from './layout.js';

const S_OK = 0;
const S_FALSE = 1;
const E_FAIL = 0x80004005;
const E_UNEXPECTED = 0x8000ffff;
const E_NOINTERFACE = 0x80004002;
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IOLE_CLIENT_SITE = '{00000118-0000-0000-C000-000000000046}';
const VT_I4 = 3;
const VT_BSTR = 8;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_BYREF = 0x4000;
const SITE_WINDOW = 0x777;

/**
 * The library over a flat memory: the control's own interfaces called
 * through their records, as the bridge would; the program's objects
 * (site, frame, sinks) JS functions behind guest vtables, each call logged.
 *
 * @param {{ commandTarget?: boolean, silent?: boolean, cancel?: boolean }} [options]
 */
function setup(options = {}){
    const bytes = new Uint8Array(0x400000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, any>} */
    const records = new Map();
    /** @type {Map<any, number>} */
    const pointers = new Map();
    let nextPointer = 0x300000;
    let nextBlock = 0x1000;
    /** @type {string[]} */
    const said = [];
    /** @type {string[]} */
    const calls = [];
    /** @type {{ hwnd: number, message: number }[]} */
    const posted = [];
    /** @type {{ hwnd: number, style: number, parent: number, cls: string }[]} */
    const windows = [];
    /** @type {Map<number, (args: number[]) => number>} */
    const entries = new Map();
    let nextEntry = 0x200000;
    const registry = createComRegistry();

    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const setU32 = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const wide = at=>{
        let text = '';
        for (let p = at; view.getUint16(p, true) !== 0; p += 2)
        {
            text += String.fromCharCode(view.getUint16(p, true));
        }
        return text;
    };
    /** @param {number} size */
    const allocate = size=>{
        const at = nextBlock;
        nextBlock += (size + 15) & ~15;
        return at;
    };
    /** @param {number} at */
    const guidAt = at=>formatGuid(bytes.subarray(at, at + 16));

    /**
     * A program object: a vtable of JS functions, its QueryInterface
     * answering the interfaces named (each a pointer, possibly its own).
     *
     * @param {string} name
     * @param {Record<number, (args: number[]) => number>} methods  by slot, from 3
     * @param {() => Record<string, number>} answers  IID -> pointer
     */
    const guestObject = (name, methods, answers)=>{
        const vtable = allocate(4 * 32);
        const pointer = allocate(8);
        setU32(pointer, vtable);
        /** @type {Record<number, (args: number[]) => number>} */
        const all = {
            0: ([, iid, out])=>{
                const found = answers()[guidAt(iid)] ?? 0;
                setU32(out, found);
                calls.push(`${name}.QI ${guidAt(iid)}`);
                return found === 0 ? E_NOINTERFACE : S_OK;
            },
            1: ()=>1,
            2: ()=>1,
            ...methods,
        };
        for (let slot = 0; slot < 32; slot++)
        {
            const entry = nextEntry += 4;
            setU32(vtable + slot * 4, entry);
            entries.set(entry, args=>{
                if (slot > 2 && !all[slot])
                {
                    calls.push(`${name}#${slot}`);
                    return E_FAIL;
                }
                return all[slot](args);
            });
        }
        return pointer;
    };

    /** @type {{ dispid: number, args: any[], rgvarg: number }[]} */
    const events = [];
    /** @param {number} at  a VARIANT @returns {any} */
    const variant = at=>{
        const vt = view.getUint16(at, true);
        if (vt === VT_BSTR)
        {
            return { vt, text: u32(at + 8) === 0 ? null : wide(u32(at + 8)) };
        }
        if (vt === (VT_BYREF | VT_VARIANT))
        {
            return { vt, inner: variant(u32(at + 8)), cell: u32(at + 8) };
        }
        return { vt, value: u32(at + 8), cell: u32(at + 8) };
    };
    const sinkMethods = {
        // IDispatch::Invoke
        6: (/** @type {number[]} */ [, dispid, , , , params])=>{
            const rgvarg = u32(params);
            const count = u32(params + 8);
            const args = [];
            for (let index = count - 1; index >= 0; index--)
            {
                args.push(variant(rgvarg + index * 16));
            }
            events.push({ dispid: dispid | 0, args, rgvarg });
            if (dispid === 250 && options.cancel)
            {
                view.setUint16(args[6].cell, 0xffff, true);
            }
            calls.push(`sink.Invoke ${dispid | 0}`);
            return S_OK;
        },
    };
    const sink = guestObject('sink', sinkMethods, ()=>({
        [IID_IUNKNOWN]: sink, [DIID_DWEB_BROWSER_EVENTS2]: sink, [IID_IDISPATCH]: sink }));
    const notify = guestObject('notify', { 3: ([, dispid])=>{
        calls.push(`notify.OnChanged ${dispid | 0}`);
        return S_OK;
    } }, ()=>({ [IID_IPROPERTY_NOTIFY_SINK]: notify }));

    const frame = guestObject('frame', {
        3: ([, out])=>(setU32(out, SITE_WINDOW), calls.push('frame.GetWindow'), S_OK),
        8: ([, active, name])=>(calls.push(`frame.SetActiveObject ${active ? 'x' : 0}`
            + ` ${name ? wide(name) : 0}`), S_OK),
        10: ()=>(calls.push('frame.SetMenu'), S_OK),
        12: ([, text])=>(calls.push(`frame.SetStatusText "${wide(text)}"`), S_OK),
        13: ([, enable])=>(calls.push(`frame.EnableModeless ${enable}`), S_OK),
    }, ()=>({}));
    const documentWindow = guestObject('doc', {
        8: ([, active])=>(calls.push(`doc.SetActiveObject ${active ? 'x' : 0}`), S_OK),
    }, ()=>({}));
    const target = guestObject('target', {
        4: ([, group, id, , pvaIn])=>(calls.push(`target.Exec ${group} ${id} `
            + `${view.getUint16(pvaIn, true)}:${u32(pvaIn + 8)}`), S_OK),
    }, ()=>({}));
    const container = guestObject('container', {}, ()=>(options.commandTarget
        ? { [IID_IOLE_COMMAND_TARGET]: target } : /** @type {Record<string, number>} */ ({})));
    /** @type {number} */
    let site = 0;
    const siteAnswers = ()=>({
        [IID_IUNKNOWN]: site, [IID_IOLE_CLIENT_SITE]: site, [IID_IOLE_WINDOW]: inPlace,
        [IID_IOLE_IN_PLACE_SITE]: inPlace, [IID_IDISPATCH]: ambient,
        [IID_IOLE_CONTROL_SITE]: controlSite });
    site = guestObject('site', {
        5: ([, out])=>(setU32(out, container), calls.push('site.GetContainer'), S_OK),
        6: ()=>(calls.push('site.ShowObject'), S_OK),
    }, siteAnswers);
    const inPlace = guestObject('inplace', {
        3: ([, out])=>(setU32(out, SITE_WINDOW), calls.push('inplace.GetWindow'), S_OK),
        5: ()=>(calls.push('inplace.CanInPlaceActivate'), S_OK),
        6: ()=>(calls.push('inplace.OnInPlaceActivate'), S_OK),
        7: ()=>(calls.push('inplace.OnUIActivate'), S_OK),
        8: ([, frameOut, docOut, pos, clip, info])=>{
            calls.push(`inplace.GetWindowContext cb=${u32(info)}`);
            setU32(frameOut, frame);
            setU32(docOut, documentWindow);
            [2, 1, 1002, 901].forEach((value, index)=>setU32(pos + index * 4, value));
            [10, 10, 990, 890].forEach((value, index)=>setU32(clip + index * 4, value));
            return S_OK;
        },
        10: ([, undoable])=>(calls.push(`inplace.OnUIDeactivate ${undoable}`), S_OK),
        11: ()=>(calls.push('inplace.OnInPlaceDeactivate'), S_OK),
    }, siteAnswers);
    const ambient = guestObject('ambient', {
        6: ([, dispid, , , flags, , result])=>{
            calls.push(`ambient.Invoke ${dispid | 0} flags=${flags}`);
            if ((dispid | 0) === -5502 || (dispid | 0) === -5501)
            {
                view.setUint16(result, VT_BOOL, true);
                view.setUint16(result + 8, (dispid | 0) === -5502 && options.silent ? 0xffff : 0,
                    true);
                return S_OK;
            }
            return E_FAIL;
        },
    }, siteAnswers);
    const controlSite = guestObject('control', {
        8: ([, focus])=>(calls.push(`control.OnFocus ${focus}`), S_OK),
    }, siteAnswers);

    let nextWindow = 0x1000;
    const host = {
        registry,
        vtables: {
            publish: (/** @type {any} */ object, /** @type {string} */ iid)=>{
                const record = object.interfaceFor(iid);
                if (!record)
                {
                    return 0;
                }
                if (!pointers.has(record))
                {
                    nextPointer += 0x10;
                    pointers.set(record, nextPointer);
                    records.set(nextPointer, record);
                }
                return /** @type {number} */ (pointers.get(record));
            },
        },
        heap: { allocate, free: ()=>{} },
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        callGuest: async(/** @type {{ entry: number, args: number[] }} */ call)=>{
            const fn = entries.get(call.entry);
            assert.ok(fn, `a call to ${call.entry.toString(16)}, which is no program object's`);
            return fn(call.args);
        },
        callerThread: ()=>undefined,
        /** @param {string} library @param {string} name @param {number[]} args */
        system: (library, name, args)=>{
            if (library === 'OLEAUT32.dll' && name === 'SysAllocStringLen')
            {
                const at = allocate(4 + args[1] * 2 + 2) + 4;
                setU32(at - 4, args[1] * 2);
                return at;
            }
            if (library === 'OLEAUT32.dll')
            {
                return 0;
            }
            if (name === 'CreateWindowExW')
            {
                const hwnd = nextWindow += 2;
                windows.push({ hwnd, style: args[3] >>> 0, parent: args[8], cls: wide(args[1]) });
                return hwnd;
            }
            if (name === 'PostMessageW')
            {
                posted.push({ hwnd: args[0], message: args[1] });
                return 1;
            }
            calls.push(`${name} ${args.join(',')}`);
            return 1;
        },
        divergence: (/** @type {string} */ api, /** @type {string} */ detail,
            /** @type {string} */ kind)=>said.push(`${api}: ${detail}${kind ? ` (${kind})` : ''}`),
    };
    const ieframe = createIeframe(/** @type {any} */ (host));

    /**
     * Calls a method of one of the control's interfaces through the pointer
     * the program holds.
     *
     * @param {number} pointer @param {string} name @param {number[]} args
     */
    const call = async(pointer, name, args = [])=>{
        const record = records.get(pointer);
        const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(method, `no ${name}`);
        return (await method.invoke(record.object, args)) >>> 0;
    };
    /** An interface of the object, as QueryInterface would hand it out. @param {any} object */
    const pointerOf = (object, /** @type {string} */ iid)=>host.vtables.publish(object, iid);
    /** A GUID in memory. @param {string} text */
    const guid = text=>{
        const at = allocate(16);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(text)), at);
        return at;
    };
    /** A VT_BSTR VARIANT. @param {string} text */
    const bstrVariant = text=>{
        const at = allocate(16);
        const string = allocate(4 + text.length * 2 + 2) + 4;
        [...text].forEach((char, index)=>view.setUint16(string + index * 2, char.charCodeAt(0),
            true));
        view.setUint16(at, VT_BSTR, true);
        setU32(at + 8, string);
        return at;
    };
    /** The window procedure of a class. @param {string} name */
    const procedure = name=>ieframe.controls({ defWindowProc: ()=>0 })
        .find(definition=>definition.name === name)?.procedure;

    /** Every message the control posted, delivered to its window. */
    const pump = async()=>{
        const proc = procedure('Shell Embedding');
        while (posted.length > 0)
        {
            const message = /** @type {{ hwnd: number, message: number }} */ (posted.shift());
            await proc({ hwnd: message.hwnd }, { hwnd: message.hwnd, message: message.message,
                wParam: 0, lParam: 0 });
        }
    };

    return { registry, ieframe, call, pointerOf, guid, bstrVariant, allocate, u32, setU32, wide,
        view, said, calls, posted, windows, events, site, sink, notify, pump, procedure };
}

/** The control made as COM makes it, with its IWebBrowser2. */
function make(/** @type {ReturnType<typeof setup>} */ t, clsid = CLSID_WEB_BROWSER){
    const object = t.registry.create(clsid);
    assert.ok(object, `${clsid} is registered`);
    return { object, browser: t.pointerOf(object, INTERFACES.IWebBrowser2.iid) };
}

test('the control answers each of its interfaces and their earlier names, one object', ()=>{
    const t = setup();
    const { object } = make(t);
    for (const iid of ['{00020400-0000-0000-C000-000000000046}',
        '{EAB22AC1-30C1-11CF-A7EB-0000C05BAE0B}', '{0002DF05-0000-0000-C000-000000000046}',
        '{00000114-0000-0000-C000-000000000046}', '{0000010D-0000-0000-C000-000000000046}',
        '{0000010C-0000-0000-C000-000000000046}', '{B196B283-BAB4-101A-B69C-00AA00341D07}',
        ...Object.values(INTERFACES).map(layout=>layout.iid)])
    {
        assert.ok(object.interfaceFor(iid), `answers ${iid}`);
    }
    assert.equal(object.interfaceFor('{00000119-0000-0000-C000-000000000046}'), null);
    assert.ok(t.registry.create(CLSID_WEB_BROWSER_V1), 'the version 1 class too');
});

test('before a site: no window, nothing loaded, Busy fails, MiscStatus as IE answers', async()=>{
    const t = setup();
    const { object, browser } = make(t);
    const out = t.allocate(16);
    assert.equal(await t.call(browser, 'get_LocationURL', [out]), S_FALSE);
    assert.equal(t.wide(t.u32(out)), '');
    assert.equal(await t.call(browser, 'get_ReadyState', [out]), S_OK);
    assert.equal(t.u32(out), 0);
    assert.equal(await t.call(browser, 'get_Busy', [out]), E_FAIL);
    assert.equal(await t.call(browser, 'get_HWND', [out]), E_FAIL);
    const ole = t.pointerOf(object, INTERFACES.IOleObject.iid);
    for (let aspect = 0; aspect < 10; aspect++)
    {
        assert.equal(await t.call(ole, 'GetMiscStatus', [aspect, out]), S_OK);
        assert.equal(t.u32(out), 0x20191);
    }
    const inPlaceObject = t.pointerOf(object, INTERFACES.IOleInPlaceObject.iid);
    t.setU32(out, 0xdead);
    assert.equal(await t.call(inPlaceObject, 'GetWindow', [out]), S_OK);
    assert.equal(t.u32(out), 0);
    t.setU32(out, 0);
    assert.equal(await t.call(browser, 'get_MenuBar', [out]), S_OK);
    assert.equal(t.view.getUint16(out, true), 0xffff, 'MenuBar is on at first');
});

test('GetGUID names the default event interface; GetClassInfo the coclass', async()=>{
    for (const [clsid, events] of [[CLSID_WEB_BROWSER, DIID_DWEB_BROWSER_EVENTS2],
        [CLSID_WEB_BROWSER_V1, DIID_DWEB_BROWSER_EVENTS]])
    {
        const t = setup();
        const { object } = make(t, clsid);
        const info = t.pointerOf(object, INTERFACES.IProvideClassInfo2.iid);
        const out = t.allocate(16);
        assert.equal(await t.call(info, 'GetGUID', [1, out]), S_OK);
        assert.equal(formatGuid(new Uint8Array(t.view.buffer, out, 16)), events);
        assert.equal(await t.call(info, 'GetGUID', [0, out]), E_FAIL);
        assert.equal(formatGuid(new Uint8Array(t.view.buffer, out, 16)),
            '{00000000-0000-0000-0000-000000000000}');
        assert.equal(await t.call(info, 'GetClassInfo', [out]), S_OK);
        const typeInfo = t.u32(out);
        assert.notEqual(typeInfo, 0);
        assert.equal(await t.call(typeInfo, 'GetTypeAttr', [out]), S_OK);
        const attr = t.u32(out);
        assert.equal(formatGuid(new Uint8Array(t.view.buffer, attr, 16)), clsid);
        assert.equal(t.u32(attr + 40), 5, 'TKIND_COCLASS');
        assert.equal(t.view.getUint16(attr + 48, true), 2, 'its interface and its events');
        assert.equal(await t.call(typeInfo, 'GetImplTypeFlags', [1, out]), S_OK);
        assert.equal(t.u32(out), 3, 'the second is the default source');
    }
});

test('a client site: three windows hidden in its window, ambients read, a session', async()=>{
    const t = setup({ silent: true });
    const { object, browser } = make(t);
    const before = t.ieframe.functions.SetQueryNetSessionCount.handler([0]);
    const ole = t.pointerOf(object, INTERFACES.IOleObject.iid);
    assert.equal(await t.call(ole, 'SetClientSite', [t.site]), S_OK);
    assert.deepEqual(t.windows.map(w=>w.cls), ['Shell Embedding', 'Shell DocObject View',
        'Internet Explorer_Server']);
    assert.equal(t.windows[0].parent, SITE_WINDOW);
    assert.equal(t.windows[0].style & 0x10000000, 0, 'the outer window waits hidden');
    assert.equal(t.windows[1].parent, t.windows[0].hwnd);
    assert.equal(t.windows[2].parent, t.windows[1].hwnd);
    assert.ok(t.calls.includes('site.GetContainer'));
    assert.ok(t.calls.includes('ambient.Invoke -5501 flags=2'));
    assert.ok(t.calls.includes('ambient.Invoke -5502 flags=2'));
    const out = t.allocate(16);
    await t.call(browser, 'get_Silent', [out]);
    assert.equal(t.view.getUint16(out, true), 0xffff, 'Silent follows the site');
    assert.equal(await t.call(browser, 'get_Busy', [out]), S_OK, 'Busy answers once sited');
    assert.equal(t.ieframe.functions.SetQueryNetSessionCount.handler([0]), before + 1);
    const inPlaceObject = t.pointerOf(object, INTERFACES.IOleInPlaceObject.iid);
    await t.call(inPlaceObject, 'GetWindow', [out]);
    assert.equal(t.u32(out), t.windows[0].hwnd);

    assert.equal(await t.call(ole, 'SetClientSite', [0]), S_OK);
    assert.ok(t.calls.includes(`DestroyWindow ${t.windows[0].hwnd}`));
    assert.equal(t.ieframe.functions.SetQueryNetSessionCount.handler([0]), before);
});

test('DoVerb activates in place through the site, frame and document window', async()=>{
    const t = setup();
    const { object } = make(t);
    const ole = t.pointerOf(object, INTERFACES.IOleObject.iid);
    await t.call(ole, 'SetClientSite', [t.site]);
    t.calls.length = 0;
    const rect = t.allocate(16);
    assert.equal(await t.call(ole, 'DoVerb', [-1, 0, t.site, 0, 0xdead, rect]), S_OK);
    const outer = t.windows[0].hwnd;
    assert.deepEqual(t.calls.filter(c=>!c.includes('.QI ')), [
        'inplace.CanInPlaceActivate', 'inplace.GetWindow', 'inplace.OnInPlaceActivate',
        'inplace.GetWindowContext cb=20',
        `MoveWindow ${outer},2,1,1000,900,1`, `MoveWindow ${outer + 2},0,0,1000,900,1`,
        `MoveWindow ${outer + 4},0,0,1000,900,1`, `ShowWindow ${outer},5`,
        'site.ShowObject', 'site.GetContainer', 'frame.GetWindow',
        'inplace.OnUIActivate', 'frame.SetActiveObject x item', 'doc.SetActiveObject x',
        'frame.SetMenu', 'control.OnFocus 1']);

    t.calls.length = 0;
    const inPlaceObject = t.pointerOf(object, INTERFACES.IOleInPlaceObject.iid);
    assert.equal(await t.call(inPlaceObject, 'InPlaceDeactivate'), S_OK);
    assert.deepEqual(t.calls, ['frame.SetActiveObject 0 0', 'doc.SetActiveObject 0',
        'inplace.OnUIDeactivate 0', `ShowWindow ${outer},0`, 'inplace.OnInPlaceDeactivate']);
});

test('Navigate2: BeforeNavigate2 and the download at once, the rest from the loop', async()=>{
    const t = setup();
    const { object, browser } = make(t);
    const ole = t.pointerOf(object, INTERFACES.IOleObject.iid);
    await t.call(ole, 'SetClientSite', [t.site]);
    const points = t.pointerOf(object, INTERFACES.IConnectionPointContainer.iid);
    const out = t.allocate(16);
    assert.equal(await t.call(points, 'FindConnectionPoint', [t.guid(DIID_DWEB_BROWSER_EVENTS2),
        out]), S_OK);
    const point = t.u32(out);
    assert.equal(await t.call(point, 'Advise', [t.sink, out]), S_OK);
    assert.equal(t.u32(out), 1, 'connections are counted from 1 on each point');
    await t.call(points, 'FindConnectionPoint', [t.guid(IID_IPROPERTY_NOTIFY_SINK), out]);
    assert.equal(await t.call(t.u32(out), 'Advise', [t.notify, out]), S_OK);
    assert.equal(t.u32(out), 1);
    t.calls.length = 0;

    const url = 'http://example.com/news';
    assert.equal(await t.call(browser, 'Navigate2', [t.bstrVariant(url), 0, 0, 0, 0]), S_OK);
    assert.deepEqual(t.events.map(e=>e.dispid), [250, 106, 102, 105, 105, 104]);
    const before = t.events[0].args;
    assert.equal(before.length, 7);
    assert.equal(before[1].inner.text, url);
    assert.deepEqual(before[3].inner, { vt: VT_BSTR, text: null }, 'no target frame');
    assert.equal(before[4].inner.vt, VT_BYREF | VT_VARIANT, 'post data by reference');
    assert.equal(before[4].inner.inner.vt, 0);
    assert.deepEqual(before[5].inner, { vt: VT_BSTR, text: null }, 'no headers');
    assert.equal(before[6].vt, VT_BYREF | VT_BOOL);
    assert.deepEqual(t.events[3].args.map((/** @type {any} */ a)=>[a.vt, a.value]),
        [[VT_I4, 2], [VT_BOOL, 0]], 'Back cannot go anywhere');
    assert.equal(t.events[1].rgvarg, 0, 'DownloadBegin has no argument array');
    assert.ok(t.calls.includes('notify.OnChanged -525'), 'the ready state is told');

    assert.equal(await t.call(browser, 'get_ReadyState', [out]), S_OK);
    assert.equal(t.u32(out), 1, 'loading');
    await t.call(browser, 'get_Busy', [out]);
    assert.equal(t.view.getUint16(out, true), 0);
    assert.equal(await t.call(browser, 'get_LocationURL', [out]), S_FALSE, 'not arrived yet');
    assert.deepEqual(t.posted, [{ hwnd: t.windows[0].hwnd, message: WM_BROWSER_NAVIGATED }]);
    assert.deepEqual(t.said, []);

    t.events.length = 0;
    await t.pump();
    assert.deepEqual(t.events.map(e=>e.dispid), [252, 113, 259]);
    assert.equal(t.events[0].args[1].inner.text, url);
    assert.equal(await t.call(browser, 'get_LocationURL', [out]), S_OK);
    assert.equal(t.wide(t.u32(out)), url);
    await t.call(browser, 'get_ReadyState', [out]);
    assert.equal(t.u32(out), 4, 'complete');
    assert.deepEqual(t.said, [`IWebBrowser2: the page at ${url} is not drawn: there is no HTML`
        + ' engine (loss)']);

    await t.call(browser, 'Navigate2', [t.bstrVariant(url), 0, 0, 0, 0]);
    await t.pump();
    assert.equal(t.said.length, 1, 'said once for each address');
    assert.equal(await t.call(browser, 'GoBack'), S_OK, 'the second visit made a history');
});

test('a sink that cancels BeforeNavigate2 stops the navigation there', async()=>{
    const t = setup({ cancel: true });
    const { object, browser } = make(t);
    await t.call(t.pointerOf(object, INTERFACES.IOleObject.iid), 'SetClientSite', [t.site]);
    const points = t.pointerOf(object, INTERFACES.IConnectionPointContainer.iid);
    const out = t.allocate(16);
    await t.call(points, 'FindConnectionPoint', [t.guid(DIID_DWEB_BROWSER_EVENTS2), out]);
    await t.call(t.u32(out), 'Advise', [t.sink, out]);
    await t.call(browser, 'Navigate2', [t.bstrVariant('http://example.com/'), 0, 0, 0, 0]);
    assert.deepEqual(t.events.map(e=>e.dispid), [250]);
    assert.deepEqual(t.posted, []);
    assert.equal(await t.call(browser, 'get_LocationURL', [out]), S_FALSE);
    assert.deepEqual(t.said, []);
});

test('a container with a command target hears the download state, not DownloadComplete', async()=>{
    const t = setup({ commandTarget: true });
    const { object, browser } = make(t);
    await t.call(t.pointerOf(object, INTERFACES.IOleObject.iid), 'SetClientSite', [t.site]);
    const points = t.pointerOf(object, INTERFACES.IConnectionPointContainer.iid);
    const out = t.allocate(16);
    await t.call(points, 'FindConnectionPoint', [t.guid(DIID_DWEB_BROWSER_EVENTS2), out]);
    await t.call(t.u32(out), 'Advise', [t.sink, out]);
    await t.call(browser, 'Navigate2', [t.bstrVariant('http://example.com/'), 0, 0, 0, 0]);
    assert.deepEqual(t.calls.filter(c=>c.startsWith('target.')), ['target.Exec 0 29 3:1',
        'target.Exec 0 29 3:0']);
    assert.ok(!t.events.some(e=>e.dispid === 104));
});

test('without a window a navigation finishes at once; commands wait for a document', async()=>{
    const t = setup();
    const { browser } = make(t);
    const out = t.allocate(16);
    assert.equal(await t.call(browser, 'Navigate', [0, 0, 0, 0, 0]), S_FALSE);
    const url = t.bstrVariant('C:\\help\\index.htm');
    assert.equal(await t.call(browser, 'Navigate', [t.u32(url + 8), 0, 0, 0, 0]), S_OK);
    assert.equal(await t.call(browser, 'get_LocationURL', [out]), S_OK);
    assert.equal(t.wide(t.u32(out)), 'file:///C:/help/index.htm');
    assert.equal(await t.call(browser, 'QueryStatusWB', [1, out]), E_UNEXPECTED);
    assert.equal(await t.call(browser, 'ExecWB', [23, 2, 0, 0]), E_UNEXPECTED);
});

test('EnumVerbs hands out one verb a call and says it fetched none, as IE does', async()=>{
    const t = setup();
    const { object } = make(t);
    const ole = t.pointerOf(object, INTERFACES.IOleObject.iid);
    const out = t.allocate(16);
    assert.equal(await t.call(ole, 'EnumVerbs', [out]), S_OK);
    const verbs = t.u32(out);
    const list = t.allocate(16 * 20);
    const fetched = t.allocate(4);
    /** @type {number[]} */
    const seen = [];
    for (let index = 0; index < 5; index++)
    {
        t.setU32(fetched, 0xdead);
        assert.equal(await t.call(verbs, 'Next', [20, list, fetched]), S_OK);
        assert.equal(t.u32(fetched), 0);
        seen.push(t.u32(list) | 0);
    }
    assert.deepEqual(seen, [0, -5, -4, -1, -3]);
    assert.equal(await t.call(verbs, 'Next', [20, list, fetched]), S_FALSE);
    assert.equal(await t.call(verbs, 'Reset'), S_OK);
    assert.equal(await t.call(verbs, 'Skip', [20]), S_OK);
    await t.call(verbs, 'Next', [1, list, 0]);
    assert.equal(t.u32(list), 0, 'Skip moved nothing');
});

test('IOleObject::Advise refuses a missing sink and Unadvise an unknown connection', async()=>{
    const t = setup();
    const { object } = make(t);
    const ole = t.pointerOf(object, INTERFACES.IOleObject.iid);
    const out = t.allocate(8);
    assert.equal(await t.call(ole, 'Unadvise', [0]), 0x80040004);
    t.setU32(out, 0xdead);
    assert.equal(await t.call(ole, 'Advise', [0, out]), 0x80070057);
    assert.equal(t.u32(out), 0);
    assert.equal(await t.call(ole, 'Advise', [t.sink, out]), S_OK);
    assert.equal(await t.call(ole, 'Advise', [t.sink, out + 4]), S_OK);
    assert.equal(t.u32(out + 4), t.u32(out) + 1);
    assert.equal(await t.call(ole, 'Unadvise', [t.u32(out + 4)]), S_OK);
    assert.equal(await t.call(ole, 'Unadvise', [t.u32(out + 4)]), 0x80040004);
    t.setU32(out, 0xdead);
    assert.equal(await t.call(ole, 'EnumAdvise', [out]), 0x80004001);
    assert.equal(t.u32(out), 0);
});

test('a connection point for an interface the control has no events on is refused', async()=>{
    const t = setup();
    const { object } = make(t);
    const points = t.pointerOf(object, INTERFACES.IConnectionPointContainer.iid);
    const out = t.allocate(8);
    assert.equal(await t.call(points, 'FindConnectionPoint', [t.guid(IID_IDISPATCH), out]),
        0x80040200);
    assert.equal(t.u32(out), 0);
    assert.equal(await t.call(points, 'FindConnectionPoint', [t.guid(DIID_DWEB_BROWSER_EVENTS),
        out]), S_OK);
    const point = t.u32(out);
    assert.equal(await t.call(point, 'GetConnectionInterface', [out]), S_OK);
    assert.equal(formatGuid(new Uint8Array(t.view.buffer, out, 16)), DIID_DWEB_BROWSER_EVENTS);
});

test('SetQueryNetSessionCount counts up and down and never below none', ()=>{
    const t = setup();
    const { handler } = t.ieframe.functions.SetQueryNetSessionCount;
    const start = handler([0]);
    assert.equal(handler([1]), start + 1);
    assert.equal(handler([0]), start + 1);
    assert.equal(handler([2]), start);
    assert.equal(handler([2]), 0);
    assert.equal(handler([0]), 0);
});

test('the classes are the three IE makes, their message finishes navigations', async()=>{
    const t = setup();
    const definitions = t.ieframe.controls({ defWindowProc: ()=>42 });
    assert.deepEqual(definitions.map(d=>d.name), ['Shell Embedding', 'Shell DocObject View',
        'Internet Explorer_Server']);
    assert.ok(definitions.every(d=>d.background === 6), 'the white of an empty page');
    const proc = /** @type {any} */ (definitions[2].procedure);
    assert.equal(await proc({ hwnd: 5 }, { hwnd: 5, message: 0x000f, wParam: 0, lParam: 0 }),
        42, 'anything else is DefWindowProc\'s');
});
