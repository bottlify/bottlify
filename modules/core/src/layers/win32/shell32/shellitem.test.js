/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IID_ISHELLITEM, createShellItems } from './shellitem.js';
import { listBytes } from './namespace.js';

const IID_IPERSISTIDLIST = '{1079ACFC-29BD-11D3-8E0D-00C04F6837D5}';
const E_INVALIDARG = 0x80070057 | 0;
const E_FAIL = 0x80004005 | 0;

/** A namespace of a few paths, and guest memory with a heap and task memory. */
function machine(){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let heap = 0x8000;
    /** @type {any[]} */
    const published = [];
    const paths = new Map([['C:\\dir', 0x20000000 | 0x40000000], ['C:\\dir\\file', 0x40000000]]);
    const items = createShellItems({
        readMemory: (at, length)=>memory.slice(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readWideString: at=>{
            let text = '';
            for (let n = at; memory[n] | memory[n + 1]; n += 2)
            {
                text += String.fromCharCode(memory[n] | memory[n + 1] << 8);
            }
            return text;
        },
        allocate: bytes=>{
            const at = heap;
            heap += bytes + 8;
            return at;
        },
        free: ()=>{},
        publish: object=>{
            published.push(object);
            return 0x1000 + published.length * 16;
        },
        library: name=>(name === 'ole32.dll' ? { CoTaskMemAlloc: { handler: ([bytes])=>{
            const at = heap;
            heap += bytes + 8;
            return at;
        } } } : undefined),
    }, {
        describe: text=>(paths.has(text) ? { text, name: text.split('\\').pop() ?? text,
            attributes: /** @type {number} */ (paths.get(text)) } : null),
        folderAt: pointer=>(pointer === 0x500 ? 'C:\\dir' : pointer === 0x600 ? null : undefined),
        parse: name=>(paths.has(name) ? { text: name } : null),
        bind: ()=>0,
    });
    /** @param {Uint8Array} bytes */
    const put = bytes=>{
        const at = heap;
        heap += bytes.length + 8;
        memory.set(bytes, at);
        return at;
    };
    /** @param {string} text */
    const wide = text=>put(Uint8Array.from([...text, '\0'].flatMap(c=>[c.charCodeAt(0), 0])));
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    /** @param {number} pointer @param {string} iid @param {string} name @param {number[]} args */
    const call = (pointer, iid, name, args)=>{
        const object = published[(pointer - 0x1000) / 16 - 1];
        return object.interfaceFor(iid).methods
            .find((/** @type {any} */ method)=>method.name === name).invoke(object, args);
    };
    /** @param {number} at */
    const listAt = at=>{
        let end = at;
        while (memory[end] | memory[end + 1])
        {
            end += memory[end] | memory[end + 1] << 8;
        }
        return [...memory.slice(at, end + 2)];
    };
    /** @param {number} at */
    const string = at=>{
        let text = '';
        for (let n = at; memory[n] | memory[n + 1]; n += 2)
        {
            text += String.fromCharCode(memory[n]);
        }
        return text;
    };
    return { items, put, wide, u32, call, listAt, string, published };
}

const OUT = 0x100;

test('an item is its parent\'s list and its own, whichever way the parent is given', ()=>{
    const m = machine();
    const dir = m.put(listBytes('C:\\dir'));
    const file = m.put(listBytes('C:\\dir\\file'));
    const both = [...listBytes('C:\\dir').slice(0, -2), ...listBytes('C:\\dir\\file')];
    assert.equal(m.items.SHCreateShellItem.handler([0, 0, 0, OUT]), E_INVALIDARG);
    assert.equal(m.u32(OUT), 0);
    for (const [parent, folder, want] of /** @type {[number, number, number[]][]} */ ([
        [0, 0, [...listBytes('C:\\dir\\file')]],
        [dir, 0, both], [0, 0x500, both], [dir, 0x600, both],
        [0, 0x600, [...listBytes('C:\\dir\\file')]]]))
    {
        assert.equal(m.items.SHCreateShellItem.handler([parent, folder, file, OUT]), 0);
        assert.equal(m.call(m.u32(OUT), IID_IPERSISTIDLIST, 'GetIDList', [OUT + 8]), 0);
        assert.deepEqual(m.listAt(m.u32(OUT + 8)), want, `${parent} ${folder}`);
    }
    assert.equal(m.items.SHCreateShellItem.handler([0, 0x700, file, OUT]), E_INVALIDARG,
        'a folder this shell did not hand out');
});

test('an item knows its parent, its names, its attributes and its equals', async()=>{
    const m = machine();
    const file = m.put(listBytes('C:\\dir\\file'));
    assert.equal(m.items.SHCreateItemFromIDList.handler([file, 0, OUT]), 0x80004002 | 0,
        'no interface named');
    const iid = m.put(Uint8Array.of(0x1e, 0x6d, 0x82, 0x43, 0x18, 0xe7, 0xee, 0x42, 0xbc,
        0x55, 0xa1, 0xe2, 0x61, 0xc3, 0x7b, 0xfe));
    assert.equal(m.items.SHCreateItemFromIDList.handler([file, iid, OUT]), 0);
    const item = m.u32(OUT);
    assert.equal(m.call(item, IID_ISHELLITEM, 'GetParent', [OUT + 4]), 0);
    assert.equal(m.call(m.u32(OUT + 4), IID_IPERSISTIDLIST, 'GetIDList', [OUT + 8]), 0);
    assert.deepEqual(m.listAt(m.u32(OUT + 8)), [...listBytes('C:\\dir')]);
    for (const [sigdn, want] of /** @type {[number, string][]} */ ([[0, 'file'],
        [0x80058000, 'C:\\dir\\file'],
        [0x80018001, 'file'], [0x80028000, 'C:\\dir\\file'],
        [0x80068000, 'file:///C:/dir/file']]))
    {
        assert.equal(await m.call(item, IID_ISHELLITEM, 'GetDisplayName', [sigdn, OUT + 12]), 0);
        assert.equal(m.string(m.u32(OUT + 12)), want, sigdn.toString(16));
    }
    assert.equal(m.call(item, IID_ISHELLITEM, 'GetAttributes', [0x40000000, OUT + 16]), 0);
    assert.equal(m.call(item, IID_ISHELLITEM, 'GetAttributes', [0x60000000, OUT + 16]), 1,
        'S_FALSE: not a folder');
    assert.equal(m.u32(OUT + 16), 0x40000000);
    const name = m.wide('C:\\dir\\file');
    assert.equal(m.items.SHCreateItemFromParsingName.handler([name, 0, iid, OUT + 20]), 0);
    assert.equal(m.call(item, IID_ISHELLITEM, 'Compare', [m.u32(OUT + 20), 0, OUT + 24]), 0);
    assert.equal(m.u32(OUT + 24), 0, 'the same item');
    assert.equal(m.call(item, IID_ISHELLITEM, 'Compare', [m.u32(OUT + 4), 0, OUT + 24]), 1);
    assert.equal(m.items.SHCreateItemFromParsingName.handler([m.wide('file'), 0, iid, OUT]),
        0x80070002 | 0, 'a relative name is not found');
    assert.equal(m.items.SHCreateItemFromParsingName.handler([0, 0, iid, OUT]), E_INVALIDARG);
    assert.equal(m.items.SHCreateItemFromRelativeName.handler([m.u32(OUT + 4),
        m.wide('file'), 0, iid, OUT + 28]), 0);
    assert.equal(m.items.SHGetIDListFromObject.handler([m.u32(OUT + 28), OUT + 32]), 0);
    assert.deepEqual(m.listAt(m.u32(OUT + 32)), [...listBytes('C:\\dir\\file')]);
    assert.equal(m.items.SHGetIDListFromObject.handler([0x500, OUT + 32]), 0, 'a folder');
    assert.deepEqual(m.listAt(m.u32(OUT + 32)), [...listBytes('C:\\dir')]);
});

test('the desktop has no parent, and an item no picture', ()=>{
    const m = machine();
    const desktop = m.put(Uint8Array.of(0, 0));
    assert.equal(m.items.SHCreateShellItem.handler([0, 0, desktop, OUT]), 0);
    assert.equal(m.call(m.u32(OUT), IID_ISHELLITEM, 'GetParent', [OUT + 4]), E_FAIL);
    assert.equal(m.u32(OUT + 4), 0);
    assert.equal(m.call(m.u32(OUT), '{BCC18B79-BA16-442F-80C4-8A59C30C463B}', 'GetImage',
        [32, 32, 0, OUT + 8]), 0x80004001 | 0);
});
