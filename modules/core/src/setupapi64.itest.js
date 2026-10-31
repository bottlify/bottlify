/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program enumerating devices: its SP_DEVINFO_DATA is 32 bytes, the
 * Reserved ULONG_PTR at 24 eight of them, as setupapi.h packs it on x64. Held
 * to the 28 bytes of a 32-bit one, every index answered
 * ERROR_INVALID_USER_BUFFER and never ERROR_NO_MORE_ITEMS, and a loop that
 * skips a device it cannot read enumerated for ever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { setupLayouts } from './layers/win32/setupapi/functions.js';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INVALID_USER_BUFFER = 1784;

test('the enumeration structures\' sizes are setupapi.h\'s at both widths', ()=>{
    assert.deepEqual(setupLayouts(4), { devinfoData: 28, interfaceData: 28, detailA: 5,
        detailW: 6, listDetailA: 287, listDetailW: 550, reserved: 4 });
    assert.deepEqual(setupLayouts(8), { devinfoData: 32, interfaceData: 32, detailA: 8,
        detailW: 8, listDetailA: 296, listDetailW: 560, reserved: 8 });
});

test('a 64-bit program enumerates devices with its own SP_DEVINFO_DATA, to the end',
    { timeout: 60000 }, async t=>{
        /** @type {Record<string, number>} */
        const where = {};
        const names = ['first', 'beyond', 'beyondError', 'narrowAnswer', 'narrowError'];
        const program = buildExe({
            bits: 64, codeSize: 0x200,
            imports: { 'SETUPAPI.dll': ['SetupDiGetClassDevsW', 'SetupDiEnumDeviceInfo'],
                'KERNEL32.dll': ['GetLastError', 'ExitProcess'] },
            data: {
                handle: new Array(8).fill(0),
                ...Object.fromEntries(names.map(name=>[name, new Array(32).fill(0x55)])),
                wide: [...u32(32), ...new Array(28).fill(0x55)],
                narrow: [...u32(28), ...new Array(28).fill(0x55)],
            },
            code: ({ iat, at, code })=>{
                names.forEach(name=>{
                    where[name] = at(name);
                });
                /** @type {number[]} */
                const bytes = [];
                /** @param {number[]} op @param {number} to */
                const rip = (op, to)=>bytes.push(...op,
                    ...u32(to - (code(bytes.length) + op.length + 4)));
                const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
                const storeEax = (/** @type {string} */ name)=>rip([0x89, 0x05], at(name));
                /** SetupDiEnumDeviceInfo(handle, index, &data) @param {number} index
                 *  @param {string} data */
                const enumerate = (index, data)=>{
                    rip([0x48, 0x8b, 0x0d], at('handle')); //              mov rcx, [handle]
                    bytes.push(0xba, ...u32(index)); //                    mov edx, index
                    rip([0x4c, 0x8d, 0x05], at(data)); //                  lea r8, [data]
                    call('SetupDiEnumDeviceInfo');
                };
                bytes.push(0x48, 0x83, 0xec, 0x28); //                     sub rsp, 40
                // SetupDiGetClassDevsW(NULL, NULL, NULL, DIGCF_PRESENT | DIGCF_ALLCLASSES)
                bytes.push(0x31, 0xc9, 0x31, 0xd2, 0x45, 0x31, 0xc0, 0x41, 0xb9, ...u32(6));
                call('SetupDiGetClassDevsW');
                rip([0x48, 0x89, 0x05], at('handle'));
                enumerate(0, 'wide');
                storeEax('first');
                enumerate(0x7fff, 'wide');
                storeEax('beyond');
                call('GetLastError');
                storeEax('beyondError');
                enumerate(0, 'narrow');
                storeEax('narrowAnswer');
                call('GetLastError');
                storeEax('narrowError');
                bytes.push(0x31, 0xc9);
                call('ExitProcess');
                where.wide = at('wide');
                return bytes;
            },
        });
        const app = await createApp({ executable: program });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30000 }), 0);
        /** @param {string} name */
        const dword = name=>new DataView(app.debug.read(where[name], 4).slice().buffer)
            .getUint32(0, true);
        assert.equal(dword('first'), 1, 'the first device, into 32 bytes');
        const data = new DataView(app.debug.read(where.wide, 32).slice().buffer);
        assert.equal(data.getUint32(28, true), 0, 'Reserved written whole');
        assert.equal(dword('beyond'), 0, 'no device past the last');
        assert.equal(dword('beyondError'), ERROR_NO_MORE_ITEMS, 'and that is the end');
        assert.equal(dword('narrowAnswer'), 0, 'a 32-bit size is refused here');
        assert.equal(dword('narrowError'), ERROR_INVALID_USER_BUFFER);
    });
