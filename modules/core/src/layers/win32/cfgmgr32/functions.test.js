/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CR, ROOT_DEVNODE, createCfgmgrFunctions } from './functions.js';

const make = (/** @type {Record<number, string>} */ strings = {})=>{
    const memory = new Uint8Array(64).fill(0xcc);
    const fns = createCfgmgrFunctions({
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readCString: at=>strings[at] ?? '',
    });
    const dword = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    return { fns, dword };
};

test('the root is found with no ID or its own, and nothing else is there', ()=>{
    const { fns, dword } = make({ 40: 'htree\\root\\0', 48: 'PCI\\VEN_8086' });
    assert.equal(fns.CM_Locate_DevNodeA.handler([4, 0, 0]), CR.SUCCESS);
    assert.equal(dword(4), ROOT_DEVNODE);
    assert.equal(fns.CM_Locate_DevNodeA.handler([8, 40, 0]), CR.SUCCESS);
    assert.equal(dword(8), ROOT_DEVNODE);
    assert.equal(fns.CM_Locate_DevNodeA.handler([12, 48, 0]), CR.NO_SUCH_DEVNODE);
    assert.equal(dword(12), 0, 'the handle is cleared on a miss');
    assert.equal(fns.CM_Locate_DevNodeA.handler([0, 0, 0]), CR.INVALID_POINTER);
    assert.equal(fns.CM_Locate_DevNodeA.handler([16, 0, 0x100]), CR.INVALID_FLAG);
});

test('a resource walk ends at its first step with "no more"', ()=>{
    const { fns, dword } = make();
    assert.equal(fns.CM_Get_First_Log_Conf.handler([4, ROOT_DEVNODE, 0]), CR.NO_MORE_LOG_CONF);
    assert.equal(dword(4), 0);
    assert.equal(fns.CM_Get_First_Log_Conf.handler([0, ROOT_DEVNODE, 2]), CR.NO_MORE_LOG_CONF);
    assert.equal(fns.CM_Get_First_Log_Conf.handler([4, 77, 0]), CR.INVALID_DEVNODE);
    assert.equal(fns.CM_Get_Next_Res_Des.handler([8, 0, 0, 0, 0]), CR.INVALID_LOG_CONF);
    assert.equal(dword(8), 0);
    assert.equal(fns.CM_Get_Res_Des_Data_Size.handler([12, 5, 0]), CR.INVALID_RES_DES);
    assert.equal(fns.CM_Get_Res_Des_Data.handler([5, 16, 4, 0]), CR.INVALID_RES_DES);
    assert.equal(fns.CM_Get_Res_Des_Data.handler([5, 0, 4, 0]), CR.INVALID_POINTER);
    assert.equal(fns.CM_Free_Log_Conf_Handle.handler(), CR.INVALID_LOG_CONF);
});

test('each entry pops its stdcall arguments', ()=>{
    const { fns } = make();
    const popped = Object.entries(fns).map(([name, fn])=>[name, fn.argBytes]);
    assert.deepEqual(Object.fromEntries(popped), {
        CM_Locate_DevNodeA: 12,
        CM_Get_First_Log_Conf: 12,
        CM_Get_Next_Res_Des: 20,
        CM_Get_Res_Des_Data_Size: 12,
        CM_Get_Res_Des_Data: 16,
        CM_Free_Log_Conf_Handle: 4,
    });
});
