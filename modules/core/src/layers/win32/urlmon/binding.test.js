/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A URL moniker bound the way an ActiveX control binds its content: a bind
 * context holding the control's IBindStatusCallback, BindToStorage for a
 * stream, and the callback told the start, the data and the end - inside the
 * call for a synchronous bind, from the thread's message loop for an
 * asynchronous one. The program's objects are stand-ins here, their methods
 * reached through vtables in a memory as the guest's are.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../ole32/objects.js';
import { createUrlMonikers } from './monikers.js';

const IID_ISTREAM = [0x0c, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46];
const MK_S_ASYNCHRONOUS = 0x000401e8;
const INET_E_RESOURCE_NOT_FOUND = 0x800c0005 | 0;

function machine(){
    const bytes = new Uint8Array(1 << 20);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    /** @param {number} size */
    const allocate = size=>{
        const at = next;
        next += (size + 15) & ~15;
        return at;
    };
    /** @type {Map<number, (args: number[]) => any>} */
    const entries = new Map();
    let entryId = 0x7f000000;
    /**
     * An object whose vtable slots run `slots`, by index.
     * @param {Record<number, (args: number[]) => any>} slots
     */
    const fake = slots=>{
        const pointer = allocate(4);
        const vtable = allocate(64 * 4);
        view.setUint32(pointer, vtable, true);
        for (const [slot, run] of Object.entries(slots))
        {
            entries.set(++entryId, run);
            view.setUint32(vtable + Number(slot) * 4, entryId, true);
        }
        return pointer;
    };
    /** @param {number} address */
    const u32 = address=>view.getUint32(address, true);
    /** @param {number} address */
    const wideAt = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    /** @param {string} text */
    const putWide = text=>{
        const at = allocate(text.length * 2 + 2);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        return at;
    };
    return { bytes, view, allocate, entries, fake, u32, wideAt, putWide };
}

/**
 * @param {{ files?: Record<string, number>, asynchronous?: boolean }} [options]
 */
function harness({ files = {}, asynchronous = false } = {}){
    const m = machine();
    /** @type {any[]} */
    const told = [];
    /** @type {(() => any)[]} */
    const posted = [];
    /** @type {((message: number) => any) | null} */
    let procedure = null;

    /** A stream on a file of the volume, its size its whole. @param {number} size */
    const stream = size=>{
        let references = 1;
        const pointer = m.fake({
            1: ()=>++references,
            2: ()=>--references,
            12: ([at])=>{
                m.view.setUint32(at + 8, size, true);
                return 0;
            },
        });
        return { pointer, references: ()=>references };
    };
    /** @type {{ pointer: number, references: () => number }[]} */
    const opened = [];

    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            m.bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>m.bytes.set(data, at),
        readWideString: (/** @type {number} */ at)=>m.wideAt(at),
        heap: { allocate: m.allocate, free: ()=>0 },
        vtables: {
            /** @param {any} object @param {string} iid */
            publish: (object, iid)=>{
                const record = object.interfaceFor(iid);
                /** @type {Record<number, (args: number[]) => any>} */
                const slots = {
                    1: ()=>object.addRef(),
                    2: ()=>object.release(),
                };
                record.methods.forEach((/** @type {any} */ method, /** @type {number} */ slot)=>{
                    if (method.invoke)
                    {
                        slots[slot] = args=>method.invoke(object, args);
                    }
                });
                return m.fake(slots);
            },
        },
        makeObject: createComObject,
        call: async(/** @type {number} */ entry, /** @type {number[]} */ args)=>
            /** @type {any} */ (m.entries.get(entry))(args.slice(1)),
        callerThread: ()=>'main',
        /** @param {string} library @param {string} name @param {number[]} args */
        system: (library, name, [pathAt, , out])=>{
            assert.equal(`${library}!${name}`, 'SHLWAPI.dll!SHCreateStreamOnFileW');
            const size = files[m.wideAt(pathAt)];
            if (size === undefined)
            {
                return 0x80070002 | 0;
            }
            const made = stream(size);
            opened.push(made);
            m.view.setUint32(out, made.pointer, true);
            return 0;
        },
        window: {
            create: (/** @type {(message: number) => any} */ handler)=>{
                procedure = handler;
                return 0x99;
            },
            post: ()=>posted.push(()=>procedure?.(0x400)),
        },
        divergence: ()=>{},
    };
    const urlmon = createUrlMonikers(/** @type {any} */ (host));

    /** @type {Map<string, number>} */
    const params = new Map();
    const context = m.fake({
        9: ([key, unknown])=>{
            params.set(m.wideAt(key), unknown);
            return 0;
        },
        10: ([key, out])=>{
            const held = params.get(m.wideAt(key)) ?? 0;
            m.view.setUint32(out, held, true);
            return held ? 0 : 0x80004005 | 0;
        },
        12: ([key])=>(params.delete(m.wideAt(key)) ? 0 : 1),
    });
    const callback = m.fake({
        0: ([, out])=>{
            m.view.setUint32(out, callback, true);
            return 0;
        },
        1: ()=>1,
        2: ()=>1,
        3: ([, binding])=>told.push(['start', binding !== 0]),
        6: ([, , code])=>told.push(['progress', code]),
        7: ([hr])=>told.push(['stop', hr | 0]),
        8: ([flagsAt])=>{
            m.view.setUint32(flagsAt, asynchronous ? 1 : 0, true);
            return 0;
        },
        9: ([flags, size, , medium])=>told.push(['data', flags, size, m.u32(medium),
            m.u32(medium + 4) !== 0]),
    });

    /** @param {string} url */
    const bind = async url=>{
        const made = m.allocate(4);
        assert.equal(await urlmon.CreateURLMoniker.handler([0, m.putWide(url), made]), 0);
        const moniker = m.u32(made);
        const iid = m.allocate(16);
        m.bytes.set(IID_ISTREAM, iid);
        const out = m.allocate(4);
        const hr = await /** @type {any} */ (m.entries.get(m.u32(m.u32(moniker) + 9 * 4)))(
            [context, 0, iid, out]);
        return { hr, stream: m.u32(out) };
    };
    const pump = async()=>{
        while (posted.length > 0)
        {
            await /** @type {() => any} */ (posted.shift())();
        }
    };
    return { m, urlmon, context, callback, told, bind, pump, opened, params };
}

test('an asynchronous bind starts in the call and delivers the file from the message loop',
    async()=>{
        const h = harness({ files: { 'C:\\TEMP\\a.~lk\\movie.swf': 1234 }, asynchronous: true });
        const registered = [h.context, h.callback, 0, 0];
        assert.equal(await h.urlmon.RegisterBindStatusCallback.handler(registered), 0);
        const { hr, stream } = await h.bind('file:///C|/TEMP/a.%7Elk/movie.swf');
        assert.equal(hr, MK_S_ASYNCHRONOUS);
        assert.equal(stream, 0, 'no stream handed back from the call');
        assert.deepEqual(h.told, [['start', true]], 'the start told inside the call, nothing else');
        await h.pump();
        assert.deepEqual(h.told.slice(1), [['progress', 14], ['progress', 4], ['progress', 6],
            ['data', 1 | 4 | 8, 1234, 4, true], ['stop', 0]]);
        assert.equal(h.opened[0].references(), 0, 'the stream let go of once told');
    });

test('a synchronous bind tells everything in the call and answers the stream', async()=>{
    const h = harness({ files: { 'C:\\dir\\b.dat': 7 } });
    await h.urlmon.RegisterBindStatusCallback.handler([h.context, h.callback, 0, 0]);
    const { hr, stream } = await h.bind('file://\\C|\\dir\\b.dat');
    assert.equal(hr, 0);
    assert.equal(stream, h.opened[0].pointer);
    assert.equal(h.opened[0].references(), 1, 'the caller\'s reference');
    assert.deepEqual(h.told.map(entry=>entry[0]),
        ['start', 'progress', 'progress', 'progress', 'data', 'stop']);
});

test('a file that is not there ends the bind as a resource not found, with no data', async()=>{
    const h = harness({ asynchronous: true });
    await h.urlmon.RegisterBindStatusCallback.handler([h.context, h.callback, 0, 0]);
    assert.equal((await h.bind('file:///C:/nothing.swf')).hr, MK_S_ASYNCHRONOUS);
    await h.pump();
    assert.deepEqual(h.told, [['start', true], ['stop', INET_E_RESOURCE_NOT_FOUND]]);
});

test('a callback registered over another hands the other back, and revoking takes it out',
    async()=>{
        const h = harness();
        await h.urlmon.RegisterBindStatusCallback.handler([h.context, h.callback, 0, 0]);
        const previous = h.m.allocate(4);
        await h.urlmon.RegisterBindStatusCallback.handler([h.context, h.callback, previous, 0]);
        assert.equal(h.m.u32(previous), h.callback);
        assert.equal(await h.urlmon.RevokeBindStatusCallback.handler([h.context, h.callback]), 0);
        assert.equal(h.params.size, 0);
        assert.equal(await h.urlmon.RegisterBindStatusCallback.handler([0, h.callback, 0, 0]),
            0x80070057 | 0);
    });
