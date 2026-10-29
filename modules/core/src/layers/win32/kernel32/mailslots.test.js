/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailslots, isMailslotName } from './mailslots.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_SEM_TIMEOUT = 121;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_INVALID_PARAMETER = 87;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const NAME = '\\\\.\\mailslot\\wine_mailslot_test';

function setup(){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let next = 0x100;
    let now = 0;
    const errors = /** @type {number[]} */ ([]);
    /** @type {Map<string, number>} */
    const threadErrors = new Map();
    /** @type {{ thread: any, reason: string, timed: any }[]} */
    const blocked = [];
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    /** @type {((thread: any) => void)[]} */
    const timeouts = [];
    let current = 'main';
    const slots = createMailslots({
        kernel: {
            block: (/** @type {any} */ thread, /** @type {string} */ reason,
                /** @type {any} */ timed)=>blocked.push({ thread, reason, timed }),
            wake: (/** @type {any} */ thread, /** @type {number} */ result)=>{
                woken.push({ thread, result });
                return true;
            },
            onTimeout: (/** @type {(thread: any) => void} */ handler)=>timeouts.push(handler),
            clock: { virtualTime: ()=>now },
        },
        handles: {
            open: (type, object)=>{
                next += 4;
                table.set(next, { type, object });
                return next;
            },
            resolve: (handle, type)=>{
                const entry = table.get(handle);
                if (!entry || (type && entry.type !== type))
                {
                    throw new Error('Invalid handle');
                }
                return entry.object;
            },
            typeOf: handle=>table.get(handle)?.type ?? null,
            holds: object=>[...table.values()].some(entry=>entry.object === object),
        },
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: (address, max)=>{
            let text = '';
            for (let at = address; at < address + max && bytes[at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[at]);
            }
            return text;
        },
        readWideString: ()=>'',
        setLastError: code=>errors.push(code),
        setLastErrorFor: (thread, code)=>threadErrors.set(thread, code),
        currentThread: ()=>current,
        park: ()=>'parked',
    });
    /** @param {number} at @param {string} text */
    const ansi = (at, text)=>{
        bytes.set([...text].map(c=>c.charCodeAt(0)), at);
        bytes[at + text.length] = 0;
        return at;
    };
    const dword = (/** @type {number} */ at)=>view.getUint32(at, true);
    const { functions } = slots;
    /** @param {number} handle */
    const info = handle=>{
        assert.equal(functions.GetMailslotInfo.handler([handle, 0x300, 0x304, 0x308, 0x30c]), 1);
        return [0x300, 0x304, 0x308, 0x30c].map(dword);
    };
    return { slots, functions, bytes, errors, threadErrors, blocked, woken, timeouts, ansi, dword,
        info, table, setNow: (/** @type {number} */ ms)=>{
            now = ms;
        }, setThread: (/** @type {string} */ thread)=>{
            current = thread;
        } };
}

test('a mailslot is named under \\\\.\\mailslot\\, once, and says what it holds', ()=>{
    const t = setup();
    assert.ok(isMailslotName(NAME) && isMailslotName(NAME.toUpperCase()));
    assert.equal(t.functions.GetMailslotInfo.handler([0xffffffff, 0, 0, 0, 0]), 0);
    assert.equal(t.errors.at(-1), ERROR_INVALID_HANDLE);
    assert.deepEqual(t.slots.open(NAME, GENERIC_READ | GENERIC_WRITE),
        { error: ERROR_FILE_NOT_FOUND });

    assert.equal(t.functions.CreateMailslotA.handler([t.ansi(0x100, 'blah'), 0, 0, 0]), 0xffffffff);
    assert.equal(t.errors.at(-1), ERROR_INVALID_NAME);
    assert.equal(t.functions.CreateMailslotA.handler([0, 0, 0, 0]), 0xffffffff);
    assert.equal(t.errors.at(-1), ERROR_PATH_NOT_FOUND);

    const slot = t.functions.CreateMailslotA.handler([t.ansi(0x100, NAME), -1, -1, 0]);
    assert.notEqual(slot, 0xffffffff);
    assert.deepEqual(t.info(slot), [0xffffffff, 0xffffffff, 0, 0xffffffff],
        'max, no message, none waiting, the timeout');
    assert.equal(t.functions.GetMailslotInfo.handler([slot, 0, 0, 0, 0]), 1, 'all pointers null');
    assert.equal(t.functions.CreateMailslotA.handler([0x100, 0, 0, 0]), 0xffffffff);
    assert.equal(t.errors.at(-1), ERROR_ALREADY_EXISTS);

    // Its server handle closed, the name is free again.
    t.table.delete(slot);
    assert.notEqual(t.functions.CreateMailslotA.handler([0x100, 0, 0, 0]), 0xffffffff);
    assert.equal(t.functions.SetMailslotInfo.handler([slot, 5]), 0);
    assert.equal(t.errors.at(-1), ERROR_INVALID_HANDLE);
});

test('clients write messages the server reads one at a time, whole, in order', ()=>{
    const t = setup();
    const slot = t.functions.CreateMailslotA.handler([t.ansi(0x100, NAME), 0, 0, 0]);
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 0);
    assert.equal(t.errors.at(-1), ERROR_SEM_TIMEOUT, 'empty, no timeout');
    assert.equal(t.slots.write(slot, 0x400, 8, 0x500), 0);
    assert.equal(t.errors.at(-1), ERROR_ACCESS_DENIED, 'the server does not write');
    assert.equal(t.slots.read(0x9999, 0x400, 16, 0x500), null, 'not a mailslot: a file\'s');

    const opened = t.slots.open(NAME.toUpperCase(), GENERIC_READ | GENERIC_WRITE);
    assert.ok('handle' in opened);
    const writer = opened.handle;
    assert.equal(t.slots.read(writer, 0x400, 16, 0x500), 0);
    assert.equal(t.errors.at(-1), ERROR_INVALID_PARAMETER, 'a client does not read');

    t.bytes.set([0x61], 0x200);
    assert.equal(t.slots.write(writer, 0x200, 1, 0x500), 1);
    assert.equal(t.dword(0x500), 1);
    t.bytes.set([0x62, 0x63], 0x200);
    assert.equal(t.slots.write(writer, 0x200, 2, 0x500), 1);
    assert.equal(t.slots.write(writer, 0x200, 0, 0x500), 1, 'a message of nothing');
    assert.deepEqual(t.info(slot), [0, 1, 3, 0]);

    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 1);
    assert.deepEqual([t.dword(0x500), t.bytes[0x400]], [1, 0x61]);
    assert.deepEqual(t.info(slot).slice(1, 3), [2, 2]);
    assert.equal(t.slots.read(slot, 0x400, 1, 0x500), 0);
    assert.equal(t.errors.at(-1), ERROR_INSUFFICIENT_BUFFER, 'too small: the message stays');
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 1);
    assert.deepEqual([t.dword(0x500), t.bytes[0x400], t.bytes[0x401]], [2, 0x62, 0x63]);
    assert.deepEqual(t.info(slot).slice(1, 3), [0, 1]);
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 1);
    assert.equal(t.dword(0x500), 0);
    assert.deepEqual(t.info(slot).slice(1, 3), [0xffffffff, 0]);

    // A client opened without write access writes nothing.
    const reader = t.slots.open(NAME, GENERIC_READ);
    assert.ok('handle' in reader);
    assert.equal(t.slots.write(reader.handle, 0x200, 1, 0x500), 0);
    assert.equal(t.errors.at(-1), ERROR_ACCESS_DENIED);
});

test('a read of an empty slot waits its timeout, and a write answers it', ()=>{
    const t = setup();
    const slot = t.functions.CreateMailslotA.handler([t.ansi(0x100, NAME), 0, 1000, 0]);
    const writer = /** @type {{ handle: number }} */ (t.slots.open(NAME, GENERIC_WRITE)).handle;
    t.setNow(50);
    t.setThread('reader');
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 'parked');
    assert.deepEqual(t.blocked.at(-1)?.timed, { deadline: 1050, result: 0 });
    assert.equal(t.errors.at(-1), ERROR_SEM_TIMEOUT, 'what it answers if the clock does');

    t.setThread('writer');
    t.bytes.set([1, 2, 3, 4], 0x200);
    assert.equal(t.slots.write(writer, 0x200, 4, 0x600), 1);
    assert.deepEqual(t.woken.at(-1), { thread: 'reader', result: 1 });
    assert.equal(t.threadErrors.get('reader'), 0);
    assert.deepEqual([t.dword(0x500), ...t.bytes.slice(0x400, 0x404)], [4, 1, 2, 3, 4]);
    assert.deepEqual(t.info(slot).slice(1, 3), [0xffffffff, 0], 'handed over, not queued');

    // A reader whose wait ran out is gone: the next message is kept.
    t.setThread('late');
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 'parked');
    t.timeouts.forEach(handler=>handler('late'));
    assert.equal(t.slots.write(writer, 0x200, 2, 0x600), 1);
    assert.deepEqual(t.info(slot).slice(1, 3), [2, 1]);

    // MAILSLOT_WAIT_FOREVER blocks with no deadline.
    assert.equal(t.functions.SetMailslotInfo.handler([slot, 0xffffffff]), 1);
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 1, 'a message there: no wait');
    assert.equal(t.slots.read(slot, 0x400, 16, 0x500), 'parked');
    assert.equal(t.blocked.at(-1)?.timed, undefined);
});

test('the native calls answer with statuses, touching the block only on a transfer', ()=>{
    const t = setup();
    const slot = t.functions.CreateMailslotA.handler([t.ansi(0x100, NAME), 0, 0, 0]);
    const writer = /** @type {{ handle: number }} */ (t.slots.open(NAME, GENERIC_WRITE)).handle;
    const block = 0x700;
    const untouched = ()=>[t.dword(block), t.dword(block + 4)];
    t.bytes.fill(0xef, block, block + 8);

    assert.equal(t.slots.read(slot, 0x400, 16, block, true), 0xc00000b5, 'STATUS_IO_TIMEOUT');
    assert.equal(t.slots.write(slot, 0x400, 16, block, true), 0xc0000022, 'STATUS_ACCESS_DENIED');
    assert.equal(t.slots.read(writer, 0x400, 16, block, true), 0xc000000d,
        'STATUS_INVALID_PARAMETER');
    assert.deepEqual(untouched(), [0xefefefef, 0xefefefef]);

    t.bytes.set([7, 8], 0x200);
    assert.equal(t.slots.write(writer, 0x200, 2, block, true), 0);
    assert.deepEqual(untouched(), [0, 2]);
    t.bytes.fill(0xef, block, block + 8);
    assert.equal(t.slots.read(slot, 0x400, 1, block, true), 0xc0000023, 'STATUS_BUFFER_TOO_SMALL');
    assert.deepEqual(untouched(), [0xefefefef, 0xefefefef]);
    assert.equal(t.slots.read(slot, 0x400, 16, block, true), 0);
    assert.deepEqual([...untouched(), t.bytes[0x400], t.bytes[0x401]], [0, 2, 7, 8]);

    // A native reader parked on an empty slot is woken with a status.
    assert.equal(t.functions.SetMailslotInfo.handler([slot, 500]), 1);
    t.setThread('native');
    assert.equal(t.slots.read(slot, 0x400, 16, block, true), 'parked');
    assert.equal(t.blocked.at(-1)?.timed.result, 0xc00000b5);
    assert.equal(t.slots.write(writer, 0x200, 1, 0x600), 1);
    assert.deepEqual(t.woken.at(-1), { thread: 'native', result: 0 });
    assert.deepEqual(untouched(), [0, 1]);

    // FileMailslotQueryInformation, of the server and of a client alike.
    t.bytes.set([9, 9, 9], 0x200);
    assert.equal(t.slots.write(writer, 0x200, 3, 0x600), 1);
    for (const handle of [slot, writer])
    {
        const record = /** @type {Uint8Array} */ (t.slots.information(handle, 26));
        const view = new DataView(record.buffer);
        assert.deepEqual([0, 4, 8, 12].map(at=>view.getUint32(at, true)), [0, 0, 3, 1]);
        assert.equal(view.getBigInt64(16, true), -5000000n, '500 ms, relative');
    }
    assert.equal(t.slots.information(slot, 5), 'unknown class');
    assert.equal(t.slots.information(0x9999, 26), null);
});
