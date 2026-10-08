/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgramFunctions } from './functions.js';

/**
 * A process for the routines: memory for the strings they place, the
 * command line at 0x100, and the libraries' calls recorded with the thread
 * each answered for.
 *
 * @param {string} commandLine @param {Record<string, Record<string, any>>} libraries
 */
function fakeHost(commandLine, libraries){
    const bytes = new Uint8Array(0x10000);
    let next = 0x1000;
    /** @type {Set<number>} */
    const live = new Set();
    /** @type {any} */
    let answeringFor = null;
    /** @type {any[]} */
    const seen = [];
    const thread = { name: 'main' };
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let i = at; bytes[i] | bytes[i + 1]; i += 2)
        {
            text += String.fromCharCode(bytes[i] | bytes[i + 1] << 8);
        }
        return text;
    };
    [...commandLine, '\0'].forEach((unit, i)=>{
        bytes[0x100 + i * 2] = unit.charCodeAt(0);
    });
    const all = {
        KERNEL32: { GetCommandLineW: { handler: ()=>0x100 } },
        ...libraries,
    };
    return {
        bytes, live, seen, thread, wideAt,
        exports: (/** @type {string} */ library)=>
            /** @type {any} */ (all)[library.replace(/\.dll$/i, '')],
        callerThread: ()=>thread,
        answering: (/** @type {any} */ who, /** @type {() => any} */ fn)=>{
            answeringFor = who;
            try
            {
                return fn();
            }
            finally
            {
                answeringFor = null;
            }
        },
        /** @param {number} entry @param {number[]} args @param {any} who */
        callGuest: async(entry, args, who)=>{
            seen.push({ guest: entry, args, thread: who });
            return 0;
        },
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 16;
            live.add(at);
            return at;
        },
        free: (/** @type {number} */ at)=>{
            live.delete(at);
        },
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        readWideString: (/** @type {number} */ at)=>wideAt(at),
        /** Who a library call answered for, at the time it ran. */
        current: ()=>answeringFor,
    };
}

test('a routine reads the process\'s command line, calls as its thread, and frees what it'
    + ' placed', async()=>{
    /** @type {any} */
    let host = null;
    host = fakeHost('rundll32 x.dll,Entry wide text', {
        KERNEL32: {
            GetCommandLineW: { handler: ()=>0x100 },
            LoadLibraryW: { handler: async(/** @type {number[]} */ [name])=>{
                host.seen.push({ load: host.wideAt(name), thread: host.current() });
                return 0x10000000;
            } },
            GetProcAddress: { handler: (/** @type {number[]} */ [, name])=>{
                const wanted = String.fromCharCode(...host.bytes.subarray(name,
                    host.bytes.indexOf(0, name)));
                return wanted === 'EntryW' ? 0x10001000 : 0;
            } },
            FreeLibrary: { handler: ()=>1 },
        },
        USER32: { CreateWindowExW: { handler: ()=>0 }, DestroyWindow: { handler: ()=>1 } },
    });
    const table = createProgramFunctions(host);
    assert.deepEqual(Object.keys(table), ['msiexec', 'rundll32', 'regsvr32']);
    assert.equal(table.rundll32.argBytes, 0);
    assert.equal(await table.rundll32.handler(), 0);
    assert.deepEqual(host.seen[0], { load: 'x.dll', thread: host.thread },
        'a library call made after an await still answers for the program\'s thread');
    assert.equal(host.seen[1].guest, 0x10001000);
    assert.equal(host.seen[1].thread, host.thread, 'and the routine runs on it');
    assert.equal(host.live.size, 0, 'every string it placed is freed');
});

test('a routine answers its program\'s exit code, and a missing export is an error', async()=>{
    const host = fakeHost('msiexec /i a.msi /qn', {
        MSI: { MsiSetInternalUI: { handler: ()=>5 },
            MsiInstallProductW: { handler: async()=>1603 } },
    });
    assert.equal(await createProgramFunctions(host).msiexec.handler(), 1603);
    assert.equal(host.live.size, 0);
    const bare = fakeHost('regsvr32 /s a.dll', {});
    await assert.rejects(createProgramFunctions(bare).regsvr32.handler(),
        /ole32\.dll!OleInitialize, which a system program calls, is not here/);
    assert.equal(bare.live.size, 0);
});
