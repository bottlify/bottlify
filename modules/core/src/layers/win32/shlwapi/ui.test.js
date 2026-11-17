/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';

/**
 * shlwapi over stand-ins for user32, gdi32, kernel32 and shell32 that record
 * what they are asked: a menu of three items (10, a submenu 0x50 at 1, 30),
 * windows 1 > 2 > 3 with 4 beside 2, a semaphore of a count, Windows 6.1.
 */
function machine(){
    /** @type {string[]} */
    const asked = [];
    /** @type {any} */
    let m = null;
    let count = 0;
    const items = [{ id: 10, sub: 0 }, { id: 0xffffffff, sub: 0x50 }, { id: 30, sub: 0 }];
    /** @type {Record<number, number[]>} */
    const children = { 1: [2, 4], 2: [3] };
    /** @param {number} hwnd */
    const parentOf = hwnd=>Number(Object.keys(children).find(key=>children[Number(key)]
        .includes(hwnd)) ?? 0);
    /** @param {string} name @param {(args: number[]) => number} body */
    const fn = (name, body)=>({ handler: (/** @type {number[]} */ args)=>{
        asked.push(`${name}(${args.join(',')})`);
        return body(args);
    } });
    const user32 = {
        GetMenuItemCount: fn('GetMenuItemCount', ()=>items.length),
        GetMenuItemID: fn('GetMenuItemID', ([, at])=>items[at].id),
        GetSubMenu: fn('GetSubMenu', ([, at])=>items[at]?.sub ?? 0),
        DeleteMenu: fn('DeleteMenu', ([, at])=>{
            items.splice(at, 1);
            return 1;
        }),
        EnableMenuItem: fn('EnableMenuItem', ()=>0),
        CheckMenuItem: fn('CheckMenuItem', ()=>8),
        GetMenuItemInfoW: fn('GetMenuItemInfoW', ([, id, , info])=>{
            const item = items.find(entry=>entry.id === id) ?? items[1];
            m.view.setUint32(info + 20, id === 0x1234 ? item.sub : 0, true);
            return 1;
        }),
        IsChild: fn('IsChild', ([parent, child])=>(parentOf(child) === parent
            || parentOf(parentOf(child)) === parent ? 1 : 0)),
        GetWindow: fn('GetWindow', ([hwnd, relation])=>{
            if (relation === 5)
            {
                return children[hwnd]?.[0] ?? 0;
            }
            const siblings = children[parentOf(hwnd)] ?? [];
            return siblings[siblings.indexOf(hwnd) + 1] ?? 0;
        }),
        IsWindowUnicode: fn('IsWindowUnicode', ([hwnd])=>(hwnd === 3 ? 1 : 0)),
        SendMessageA: fn('SendMessageA', ()=>0),
        SendMessageW: fn('SendMessageW', ()=>0),
        DefWindowProcW: fn('DefWindowProcW', ()=>7),
        DefWindowProcA: fn('DefWindowProcA', ()=>8),
        GetDC: fn('GetDC', ()=>0x99),
        ReleaseDC: fn('ReleaseDC', ()=>1),
        GetClassInfoA: fn('GetClassInfoA', ([, name])=>(m.read(name) === 'Known' ? 1 : 0)),
        RegisterClassA: fn('RegisterClassA', ()=>0xc001),
    };
    const gdi32 = { GetDeviceCaps: fn('GetDeviceCaps', ([, index])=>(index === 12 ? 32 : 1)) };
    const kernel32 = {
        GetVersion: fn('GetVersion', ()=>0x1db10106),
        CreateSemaphoreW: fn('CreateSemaphoreW', ([, initial])=>{
            count = initial;
            return 0x77;
        }),
        ReleaseSemaphore: fn('ReleaseSemaphore', ([, add, previous])=>{
            m.view.setUint32(previous, count, true);
            count += add;
            return 1;
        }),
        WaitForSingleObject: fn('WaitForSingleObject', ()=>{
            if (count === 0)
            {
                return 0x102;
            }
            count--;
            return 0;
        }),
        GetModuleFileNameW: fn('GetModuleFileNameW', ([, at])=>{
            m.memory.set(new Uint8Array([...'C:\\App\\res.dll\0'].flatMap(unit=>[
                unit.charCodeAt(0), 0])), at);
            return 14;
        }),
    };
    const shell32 = { DllGetVersion: fn('DllGetVersion', ([info])=>{
        m.view.setUint32(info + 4, 6, true);
        return 0;
    }) };
    /** @type {Record<string, any>} */
    const libraries = { 'USER32.dll': user32, 'GDI32.dll': gdi32, 'KERNEL32.dll': kernel32,
        'SHELL32.dll': shell32 };
    m = shlwapiMachine({ library: (/** @type {string} */ name)=>libraries[name] });
    return { m, asked, items, counter: ()=>count };
}

test('the menu helpers go through user32 by command id', ()=>{
    const { m, asked, items } = machine();
    assert.equal(m.fns.SHMenuIndexFromID.handler([0x40, 30]), 2);
    assert.equal(m.fns.GetMenuPosFromID.handler([0x40, 99]), -1);
    m.fns.SHEnableMenuItem.handler([0x40, 10, 0]);
    assert.ok(asked.includes('EnableMenuItem(64,10,1)'), 'MF_GRAYED');
    assert.equal(m.fns.SHCheckMenuItem.handler([0x40, 10, 1]), 8);
    assert.ok(asked.includes('CheckMenuItem(64,10,8)'), 'MF_CHECKED');
    assert.equal(m.fns.SHGetMenuFromID.handler([0x40, 0x1234]), 0x50);
    assert.equal(m.fns.SHRemoveAllSubMenus.handler([0x40]), 3, 'the count it had');
    assert.deepEqual(items.map(item=>item.id), [10, 30], 'the submenu item gone');
});

test('the window helpers walk and answer as Windows does', ()=>{
    const { m, asked } = machine();
    assert.equal(m.fns.SHIsChildOrSelf.handler([1, 3]), 0, 'a descendant: FALSE');
    assert.equal(m.fns.SHIsChildOrSelf.handler([1, 1]), 0);
    assert.equal(m.fns.SHIsChildOrSelf.handler([2, 4]), 1);
    m.fns.SHPropagateMessage.handler([1, 0x400, 5, 6, 1]);
    assert.deepEqual(asked.filter(entry=>entry.startsWith('SendMessage')),
        ['SendMessageA(2,1024,5,6)', 'SendMessageW(3,1024,5,6)', 'SendMessageA(4,1024,5,6)'],
        'every descendant, each in its own encoding');
    assert.equal(m.fns.SHDefWindowProc.handler([3, 1, 2, 3]), 7);
    assert.equal(m.fns.SHDefWindowProc.handler([2, 1, 2, 3]), 8);
    assert.equal(m.fns.SHGetCurColorRes.handler([]), 32);
    assert.equal(m.fns.SHRegisterClassA.handler([0]), 0);
});

test('IsOS answers an NT workstation of the machine\'s version', ()=>{
    const { m } = machine();
    const is = (/** @type {number} */ feature)=>m.fns.IsOS.handler([feature]);
    assert.deepEqual([1, 3, 7, 18, 20].map(is), [1, 1, 1, 1, 1], 'NT, 4+, 2000+, XP+, pro');
    assert.deepEqual([0, 2, 5, 23, 29, 30].map(is), [0, 0, 0, 0, 0, 0],
        '9x, servers and WOW64 are not');
    assert.equal(m.fns.WhichPlatform.handler([]), 3);
    assert.equal(m.fns.GetUIVersion.handler([]), 6);
});

test('the global counters are a semaphore\'s count', ()=>{
    const { m, counter } = machine();
    const handle = m.fns.SHGlobalCounterCreateNamedA.handler([m.put('Counter'), 2]);
    assert.equal(handle, 0x77);
    assert.equal(m.fns.SHGlobalCounterGetValue.handler([handle]), 2);
    assert.equal(counter(), 2, 'read without changing it');
    assert.equal(m.fns.SHGlobalCounterIncrement.handler([handle]), 3);
    assert.equal(m.fns.SHGlobalCounterDecrement.handler([handle]), 2);
    const slot = m.count(5);
    assert.equal(m.fns.SHInterlockedCompareExchange.handler([slot, 9, 5]), 5);
    assert.equal(m.dwordAt(slot), 9);
    assert.equal(m.fns.SHInterlockedCompareExchange.handler([slot, 1, 5]), 9, 'not replaced');
    assert.equal(m.dwordAt(slot), 9);
});

test('MLBuildResURL makes a res: URL of the library\'s path and the resource', ()=>{
    const { m } = machine();
    const out = m.put('', true, 0x200);
    assert.equal(m.fns.MLBuildResURLW.handler([0, 0x400000, 0, m.put('page.htm', true), out,
        0x100]), 0);
    assert.equal(m.read(out, true), 'res://C:\\App\\res.dll/page.htm');
    assert.equal(m.fns.MLBuildResURLW.handler([0, 0x400000, 0, m.put('page.htm', true), out,
        5]) >>> 0, 0x80070057, 'no room');
});
