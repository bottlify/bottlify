/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellExtras } from './extras.js';

/**
 * The extras over guest memory, a kernel32 that expands `%X%` to `y`, a
 * volume of the paths given and a table of shell32's own the test fills.
 *
 * @param {string[]} [paths]
 * @param {Record<string, { handler: (args: number[]) => any }>} [table]
 */
function machine(paths = [], table = {}){
    const memory = new Uint8Array(0x100000);
    let heap = 0x10000;
    const narrow = (/** @type {number} */ at)=>{
        let text = '';
        while (memory[at] !== 0)
        {
            text += String.fromCharCode(memory[at++]);
        }
        return text;
    };
    const wide = (/** @type {number} */ at)=>{
        let text = '';
        for (; memory[at] | memory[at + 1]; at += 2)
        {
            text += String.fromCharCode(memory[at] | memory[at + 1] << 8);
        }
        return text;
    };
    const put = (/** @type {string} */ text, isWide = false, at = 0x1000)=>{
        if (isWide)
        {
            [...text, '\0'].forEach((c, i)=>{
                memory[at + i * 2] = c.charCodeAt(0) & 0xff;
                memory[at + i * 2 + 1] = c.charCodeAt(0) >>> 8;
            });
        }
        else
        {
            memory.set(Uint8Array.from(`${text}\0`, c=>c.charCodeAt(0)), at);
        }
        return at;
    };
    const kernel32 = {
        GetSystemDirectoryW: { handler: (/** @type {number[]} */ [to])=>{
            put('C:\\WINDOWS\\system32', true, to);
            return 'C:\\WINDOWS\\system32'.length;
        } },
        ExpandEnvironmentStringsA: { handler: (/** @type {number[]} */ [from, to])=>{
            const text = narrow(from).replace('%X%', 'yyy');
            put(text, false, to);
            return text.length + 1;
        } },
        ExpandEnvironmentStringsW: { handler: (/** @type {number[]} */ [from, to])=>{
            const text = wide(from).replace('%X%', 'yyy');
            put(text, true, to);
            return text.length + 1;
        } },
    };
    /** @type {any[]} */
    const published = [];
    const extras = createShellExtras({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readCString: at=>narrow(at),
        readWideString: at=>wide(at),
        allocate: bytes=>{
            const at = heap;
            heap += bytes + 16;
            return at;
        },
        free: ()=>{},
        library: name=>(name === 'KERNEL32.dll' ? kernel32 : undefined),
        publish: object=>{
            published.push(object);
            return 0x7000 + published.length * 16;
        },
    }, {
        table,
        listFor: ()=>0x9000,
        exists: path=>paths.includes(path),
        parse: name=>(paths.includes(name) ? { text: name, attributes: 0x40000000 } : null),
    });
    const u32 = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    return { extras, memory, put, narrow, wide, u32, published };
}

test('DoEnvironmentSubst expands in place when it fits, the ANSI one a byte to spare', async()=>{
    // Wine's test_DoEnvironmentSubst: "a%X%b" is "ayyyb", five characters and a terminator.
    for (const isWide of [false, true])
    {
        const m = machine();
        const call = m.extras[isWide ? 'DoEnvironmentSubstW' : 'DoEnvironmentSubstA'].handler;
        const read = isWide ? m.wide : m.narrow;
        m.put('a%X%b', isWide);
        assert.equal(await call([0x1000, 260]), (1 << 16 | 6) >>> 0);
        assert.equal(read(0x1000), 'ayyyb');
        m.put('a%X%b', isWide);
        assert.equal(await call([0x1000, 7]), (1 << 16 | 6) >>> 0, 'one to spare');
        m.put('a%X%b', isWide);
        assert.equal(await call([0x1000, 6]), isWide ? (1 << 16 | 6) >>> 0 : 6,
            'exactly the answer: the wide one fits, the ANSI one does not');
        m.put('a%X%b', isWide);
        assert.equal(await call([0x1000, 5]), 5, 'too small: FALSE and the size');
        assert.equal(read(0x1000), 'a%X%b', 'untouched');
    }
});

test('SHGetFolderPathAndSubDir puts the subdirectory under the folder, verified or made', async()=>{
    /** @type {string[]} */
    const made = [];
    /** @type {any} */
    let m = null;
    const table = {
        SHGetFolderPathA: { handler: (/** @type {number[]} */ [, csidl, , , out])=>{
            if ((csidl & 0xff) === 0xff)
            {
                return 0x80070057 | 0;
            }
            m.put('C:\\AppData', false, out);
            return 0;
        } },
        SHCreateDirectoryExW: { handler: (/** @type {number[]} */ [, path])=>{
            made.push(m.wide(path));
            return 0;
        } },
    };
    m = machine(['C:\\AppData'], table);
    const call = m.extras.SHGetFolderPathAndSubDirA.handler;
    const out = 0x3000;
    assert.equal(await call([0, 0x40ff, 0, 0, m.put('wine'), out]), 0x80070057 | 0);
    assert.equal(await call([0, 0x401c, 0, 0, m.put('wine\\temp'), out]), 0);
    assert.equal(m.narrow(out), 'C:\\AppData\\wine\\temp', 'not verified');
    for (const sub of ['', '\\'])
    {
        assert.equal(await call([0, 0x401c, 0, 0, m.put(sub), out]), 0);
        assert.equal(m.narrow(out), 'C:\\AppData');
    }
    assert.equal(await call([0, 0x401c, 0, 0, 0, out]), 0, 'no subdirectory');
    assert.equal(await call([0, 0x401c, 0, 0, m.put('x'.repeat(260)), out]), 0x800700ce | 0);
    assert.equal(await call([0, 0x1c, 0, 0, m.put('wine'), out]), 0x80070003 | 0,
        'verified, and not there');
    assert.equal(await call([0, 0x801c, 0, 0, m.put('wine'), out]), 0);
    assert.deepEqual(made, ['C:\\AppData\\wine'], 'made');
});

test('SHGetNewLinkInfo names a shortcut next to its siblings, for a target that is there', ()=>{
    // Wine's test_sh_new_link_info.
    const m = machine(['C:\\t\\a.txt', 'C:\\d\\a.txt - Shortcut.lnk']);
    const call = m.extras.SHGetNewLinkInfoA.handler;
    const must = 0x3000;
    m.memory.fill(1, must, must + 4);
    assert.equal(call([m.put('C:\\t\\none.txt', false, 0x1000), m.put('C:\\d', false, 0x1100),
        0x2000, must, 0]), 0);
    assert.equal(m.u32(must), 0);
    assert.equal(call([m.put('C:\\t\\a.txt', false, 0x1000), m.put('C:\\d', false, 0x1100),
        0x2000, must, 0]), 1);
    assert.equal(m.narrow(0x2000), 'C:\\d\\a.txt - Shortcut (2).lnk', 'past the one there');
    assert.equal(call([0x1000, m.put('C:\\e', false, 0x1100), 0x2000, must, 0x2]), 1);
    assert.equal(m.narrow(0x2000), 'C:\\e\\Shortcut to a.txt.lnk');
});

test('the cabinet state, the image lists and the notifications answer as defaults', ()=>{
    const m = machine();
    assert.equal(m.extras.ReadCabinetState.handler([0x2000, 12]), 0, 'FALSE: nothing saved');
    assert.deepEqual([m.memory[0x2000], m.memory[0x2002]], [12, 2]);
    const iid = m.put('', false, 0x1000);
    m.memory.set([0x26, 0x59, 0xeb, 0x46, 0x2e, 0x58, 0x17, 0x40, 0x9f, 0xdf, 0xe8, 0x99, 0x8d,
        0xaa, 0x09, 0x50], iid);
    assert.equal(m.extras.SHGetImageList.handler([0, iid, 0x3000]), 0);
    const large = m.u32(0x3000);
    assert.equal(m.extras.SHGetImageList.handler([0, iid, 0x3000]), 0);
    assert.equal(m.u32(0x3000), large, 'the same list each time');
    assert.equal(m.extras.SHGetImageList.handler([5, iid, 0x3000]), 0x80070057 | 0);
    assert.equal(m.extras.Shell_GetImageLists.handler([0x3004, 0x3008]), 1);
    assert.equal(m.u32(0x3004), large);
    const sizes = m.published.map(object=>object.state.size);
    assert.deepEqual(sizes, [32, 16]);
    for (const index of [2, 3, 4])
    {
        assert.equal(m.extras.SHGetImageList.handler([index, iid, 0x3000]), 0);
    }
    assert.deepEqual(m.published.map(object=>object.state.size), [32, 16, 48, 16, 256],
        'large, small, extra large, the system\'s small, jumbo');
    // Ours, then one per SHGetImageList; Shell_GetImageLists hands out none.
    assert.equal(m.published[0].addRef(), 4);
    const id = m.extras.SHChangeNotifyRegister.handler([0x40, 0, 0, 0x400, 1, 0x2000]);
    assert.notEqual(id, 0);
    assert.equal(m.extras.SHChangeNotifyDeregister.handler([id]), 1);
    assert.equal(m.extras.SHChangeNotifyDeregister.handler([id]), 0);
});

test('a stock icon is in the shell\'s library, and an id out of range is no icon', async()=>{
    const m = machine();
    const info = 0x5000;
    /** @param {number} size */
    const sized = size=>{
        m.memory.fill(0x23, info, info + 0x240);
        m.memory.set([size & 0xff, size >>> 8, 0, 0], info);
    };
    sized(536);
    assert.equal(await m.extras.SHGetStockIconInfo.handler([3, 0, info]), 0);
    assert.equal(m.u32(info + 4), 0, 'no handle without SHGSI_ICON');
    assert.equal(m.u32(info + 8) | 0, -1, 'no system image index');
    assert.equal(m.u32(info + 12), 3);
    assert.equal(m.wide(info + 16), 'C:\\WINDOWS\\system32\\shell32.dll');
    for (const id of [-1, 181, 205])
    {
        sized(536);
        assert.equal(await m.extras.SHGetStockIconInfo.handler([id, 0, info]), 0x80070057 | 0);
        assert.equal(m.u32(info + 8) | 0, -1);
        assert.equal(m.u32(info + 12) | 0, -1);
    }
    for (const size of [534, 535, 537, 538])
    {
        sized(size);
        assert.equal(await m.extras.SHGetStockIconInfo.handler([3, 0, info]), 0x80070057 | 0,
            `cbSize ${size}`);
    }
    assert.equal(await m.extras.SHGetStockIconInfo.handler([3, 0, 0]), 0x80070057 | 0);
});
