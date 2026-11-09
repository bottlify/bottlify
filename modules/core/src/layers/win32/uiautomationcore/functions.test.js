/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * UI Automation's core with no client: identifiers by GUID, the reserved
 * values, the provider a window is hosted with, events that reach nobody.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUiaFunctions } from './functions.js';
import { UIA_IDS } from './ids.js';

const IID_UNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_PROVIDER = '{D6DD68D1-86FD-4332-8666-9ABEDEA2D24C}';

function setup(){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { object: any, iid: string }>} */
    const published = new Map();
    let next = 0x8000;
    /** @type {string[]} */
    const said = [];
    const fns = createUiaFunctions({
        readMemory: (at, length)=>bytes.slice(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        vtables: { publish: (object, iid)=>{
            for (const [pointer, entry] of published)
            {
                if (entry.object === object && entry.iid === iid)
                {
                    return pointer;
                }
            }
            next += 0x10;
            published.set(next, { object, iid });
            return next;
        } },
        isWindow: hwnd=>hwnd === 0x10010,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    /** @param {number} at @param {string} text */
    const putGuid = (at, text)=>{
        const hex = text.replace(/[{}-]/g, '');
        view.setUint32(at, parseInt(hex.slice(0, 8), 16), true);
        view.setUint16(at + 4, parseInt(hex.slice(8, 12), 16), true);
        view.setUint16(at + 6, parseInt(hex.slice(12, 16), 16), true);
        for (let i = 0; i < 8; i++)
        {
            bytes[at + 8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
        }
        return at;
    };
    return { fns, view, published, said, putGuid };
}

test('UiaLookupId answers each identifier by its kind and GUID; another kind is 0', ()=>{
    const { fns, putGuid, said } = setup();
    // RuntimeId_Property_GUID and Invoke_Pattern_GUID, as the SDK defines them.
    putGuid(0x100, '{A39EEBFA-7FBA-4C89-B4D4-B99E2DE7D160}');
    assert.equal(fns.UiaLookupId.handler([0, 0x100]), 30000);
    assert.equal(fns.UiaLookupId.handler([2, 0x100]), 0, 'a property GUID asked as an event');
    for (const [type, guid, id] of UIA_IDS.filter((_, index)=>index % 37 === 0))
    {
        putGuid(0x100, guid);
        assert.equal(fns.UiaLookupId.handler([type, 0x100]), id, guid);
    }
    assert.ok(UIA_IDS.some(([type, , id])=>type === 1 && id === 10000), 'InvokePattern');
    assert.ok(UIA_IDS.some(([type, , id])=>type === 3 && id === 50000), 'Button');
    putGuid(0x100, '{628209F0-7C9A-4D57-BE64-1F1836571FF5}');
    assert.equal(fns.UiaLookupId.handler([4, 0x100]), 0);
    assert.match(said.join(), /type 4/);
});

test('the reserved values are one object each, the same pointer every time', ()=>{
    const { fns, view, published } = setup();
    assert.equal(fns.UiaGetReservedMixedAttributeValue.handler([0x200]), 0);
    assert.equal(fns.UiaGetReservedMixedAttributeValue.handler([0x204]), 0);
    assert.equal(fns.UiaGetReservedNotSupportedValue.handler([0x208]), 0);
    const [mixed, again, notSupported] = [0x200, 0x204, 0x208].map(at=>view.getUint32(at, true));
    assert.equal(mixed, again);
    assert.notEqual(mixed, notSupported);
    assert.equal(published.get(mixed)?.iid, IID_UNKNOWN);
    assert.equal(fns.UiaGetReservedMixedAttributeValue.handler([0]) >>> 0, 0x80004003);
});

test('a window\'s host provider knows its handle; no window is E_INVALIDARG', ()=>{
    const { fns, view, published } = setup();
    assert.equal(fns.UiaHostProviderFromHwnd.handler([0x10010, 0x300]), 0);
    const entry = published.get(view.getUint32(0x300, true));
    assert.equal(entry?.iid, IID_PROVIDER);
    const methods = entry?.object.interfaceFor(IID_PROVIDER).methods;
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>methods
        .find((/** @type {any} */ method)=>method.name === name).invoke(entry?.object, args);
    assert.equal(call('get_ProviderOptions', [0x310]), 0);
    assert.equal(view.getUint32(0x310, true), 1, 'ProviderOptions_ClientSideProvider');
    assert.equal(call('GetPropertyValue', [30020, 0x320]), 0);
    assert.deepEqual([view.getUint16(0x320, true), view.getUint32(0x328, true)], [3, 0x10010]);
    assert.equal(call('GetPropertyValue', [30005, 0x320]), 0);
    assert.equal(view.getUint16(0x320, true), 0, 'VT_EMPTY: a name the host does not know');
    assert.equal(fns.UiaHostProviderFromHwnd.handler([0x20020, 0x300]) >>> 0, 0x80070057);
    assert.equal(view.getUint32(0x300, true), 0);
});

test('no client listens: events go nowhere, WM_GETOBJECT is answered with nothing', ()=>{
    const { fns } = setup();
    assert.equal(fns.UiaClientsAreListening.handler(), 0);
    assert.equal(fns.UiaRaiseAutomationEvent.handler([0x8010, 20000]), 0);
    assert.equal(fns.UiaRaiseAutomationEvent.handler([0, 20000]) >>> 0, 0x80070057);
    assert.equal(fns.UiaRaiseAutomationPropertyChangedEvent.argBytes, 40);
    assert.equal(fns.UiaReturnRawElementProvider.handler([0x10010, 0, -25, 0x8010]), 0);
});
