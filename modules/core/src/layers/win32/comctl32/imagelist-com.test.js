/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageLists } from './imagelist.js';
import { CLSID_IMAGELIST, IID_IIMAGELIST, IID_IIMAGELIST2 } from './imagelist-com.js';
import { guestOver } from '../common/guest.fixture.js';

/**
 * Image lists published as COM objects, as Wine's imagelist test sees them
 * on Windows (test_iimagelist, test_IImageList_*): the handle is the
 * IImageList, Destroy is a Release, and the methods answer HRESULTs.
 */

const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;
const RIID = 0x100;
const OUT = 0x200;

/** @param {string} text */
const guidBytes = text=>{
    const hex = text.replace(/[{}-]/g, '');
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
    view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
    view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
    for (let at = 0; at < 8; at++)
    {
        bytes[8 + at] = parseInt(hex.slice(16 + at * 2, 18 + at * 2), 16);
    }
    return bytes;
};

function machine(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    /** @type {Map<number, any>} */
    const published = new Map();
    let next = 0x8000;
    const lists = createImageLists({
        guest: guestOver(memory),
        vtables: { publish: object=>{
            for (const [pointer, held] of published)
            {
                if (held === object)
                {
                    return pointer;
                }
            }
            published.set(next, object);
            return (next += 0x10) - 0x10;
        } },
    });
    const fns = /** @type {any} */ (lists.functions);
    /** @param {number} handle @param {string} name @param {number[]} args */
    const call = (handle, name, args)=>published.get(handle).interfaceFor(IID_IIMAGELIST2)
        .methods.find((/** @type {any} */ m)=>m.name === name).invoke(published.get(handle), args);
    /** @param {string} iid @param {number} [at] */
    const riid = (iid, at = RIID)=>{
        memory.set(guidBytes(iid), at);
        return at;
    };
    return { fns, call, riid, published, u32: (/** @type {number} */ at)=>view.getUint32(at, true) };
}

test('a list is the IImageList its handle points at; Destroy is a Release', ()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([32, 32, 0, 1, 1]);
    assert.ok(m.published.has(list), 'the handle is the published object');
    assert.equal(m.published.get(list).addRef(), 2);
    assert.equal(m.fns.ImageList_Destroy.handler([list]), 1, 'one reference let go');
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 0, 'still a list');
    assert.equal(m.fns.ImageList_Destroy.handler([list]), 1, 'the last one');
    assert.equal(m.fns.ImageList_Destroy.handler([list]), 0, 'gone');
});

test('HIMAGELIST_QueryInterface hands back the handle itself, referenced', ()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([16, 16, 0, 1, 1]);
    for (const iid of [IID_IIMAGELIST, IID_IIMAGELIST2])
    {
        assert.equal(m.fns.HIMAGELIST_QueryInterface.handler([list, m.riid(iid), OUT]), 0);
        assert.equal(m.u32(OUT), list);
    }
    assert.equal(m.published.get(list).release(), 2, 'two more than the creator\'s');
    assert.equal(m.fns.HIMAGELIST_QueryInterface.handler([list,
        m.riid('{00000000-0000-0000-0000-0000000000AA}'), OUT]), E_NOINTERFACE);
});

test('ImageList_CoCreateInstance makes an empty list that Initialize sizes', ()=>{
    const m = machine();
    const clsid = m.riid(CLSID_IMAGELIST, 0x500);
    assert.equal(m.fns.ImageList_CoCreateInstance.handler([clsid, 0, m.riid(IID_IIMAGELIST2), OUT]),
        0);
    const list = m.u32(OUT);
    assert.equal(m.call(list, 'Initialize', [24, 24, 0x18, 1, 1]), 0);
    assert.equal(m.fns.ImageList_GetIconSize.handler([list, 0x400, 0x404]), 1);
    assert.deepEqual([m.u32(0x400), m.u32(0x404)], [24, 24]);
    assert.equal(m.fns.ImageList_CoCreateInstance.handler([m.riid(IID_IIMAGELIST, 0x500), 0,
        m.riid(IID_IIMAGELIST2), OUT]), CLASS_E_CLASSNOTAVAILABLE, 'another class');
});

test('IImageList refuses what is out of range with E_INVALIDARG', ()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([16, 16, 0, 1, 1]);
    assert.equal(m.call(list, 'Remove', [0]), E_INVALIDARG, 'nothing to remove');
    assert.equal(m.call(list, 'Remove', [-1]), 0, 'removing everything from nothing');
    assert.equal(m.call(list, 'GetIconSize', [0, 0x400]), E_INVALIDARG);
    assert.equal(m.call(list, 'GetImageCount', [0x400]), 0);
    assert.equal(m.u32(0x400), 0);
});
