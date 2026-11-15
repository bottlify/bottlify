/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETFX_SUCCESS, runFrameworkSetup } from './netfx.js';

/**
 * The setup's routine over a machine of that width whose volume has the
 * files `present` names: the layers it asked for, and its exit code.
 *
 * @param {{ amd64?: boolean, present?: string[] }} machine
 */
async function setup({ amd64 = false, present = [] }){
    /** @type {Map<number, Uint8Array>} */
    const memory = new Map();
    let next = 0x1000;
    /** @param {Uint8Array} bytes */
    const place = bytes=>{
        const at = next;
        next += 0x1000;
        memory.set(at, bytes);
        return at;
    };
    /** @param {string} text */
    const wide = text=>place(new Uint8Array(Buffer.from(`${text}\0`, 'utf16le')));
    /** @type {string[]} */
    const asked = [];
    const code = await runFrameworkSetup(/** @type {any} */ ({
        commandLine: '"D:\\Redist\\ndp48-x86-x64-allos-enu.exe" /q /norestart',
        block: (/** @type {number} */ size)=>place(new Uint8Array(size)),
        wide,
        read: (/** @type {number} */ at, /** @type {number} */ length)=>memory.get(at)
            ?.slice(0, length) ?? new Uint8Array(length),
        /** @param {string} library @param {string} name @param {number[]} args */
        call: async(library, name, args)=>{
            assert.equal(library, 'KERNEL32.dll');
            if (name === 'GetNativeSystemInfo')
            {
                memory.get(args[0])?.set([amd64 ? 9 : 0, 0]);
                return 0;
            }
            if (name === 'GetWindowsDirectoryW')
            {
                memory.get(args[0])?.set(Buffer.from('C:\\WINDOWS', 'utf16le'));
                return 10;
            }
            if (name === 'GetFileAttributesW')
            {
                const bytes = memory.get(args[0]) ?? new Uint8Array(0);
                const path = Buffer.from(bytes).toString('utf16le').replace(/\0.*$/s, '');
                return present.includes(path) ? 0x20 : 0xffffffff;
            }
            throw new Error(`${name} is not expected`);
        },
        need: (/** @type {string} */ layer)=>asked.push(layer),
    }));
    return { code, asked };
}

const SHIM32 = 'C:\\WINDOWS\\Microsoft.NET\\Framework\\v4.0.30319\\mscoreei.dll';
const SHIM64 = 'C:\\WINDOWS\\Microsoft.NET\\Framework64\\v4.0.30319\\mscoreei.dll';

test('a Framework setup on a machine without the Framework asks for its layer and succeeds',
    async()=>{
        assert.deepEqual(await setup({}), { code: NETFX_SUCCESS, asked: ['dotnet48-x86'] });
        assert.deepEqual(await setup({ amd64: true, present: [SHIM32] }),
            { code: NETFX_SUCCESS, asked: ['dotnet48-amd64'] },
            'a 64-bit machine wants both widths');
    });

test('with the Framework\'s layer mounted, the setup is answered as run, asking for nothing',
    async()=>{
        assert.deepEqual(await setup({ present: [SHIM32] }), { code: NETFX_SUCCESS, asked: [] });
        assert.deepEqual(await setup({ amd64: true, present: [SHIM64] }),
            { code: NETFX_SUCCESS, asked: [] });
    });
