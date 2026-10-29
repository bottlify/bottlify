/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventLogFunctions } from './eventlog.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

function setup(){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let next = 4;
    const fns = /** @type {Record<string, any>} */ (createEventLogFunctions({
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        readWideString: (address, maxLength)=>{
            let text = '';
            for (let at = 0; at < maxLength; at += 2)
            {
                const code = bytes[address + at] | bytes[address + at + 1] << 8;
                if (code === 0)
                {
                    break;
                }
                text += String.fromCharCode(code);
            }
            return text;
        },
        setLastError: code=>errors.push(code),
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        now: ()=>1000,
        computerName: 'HOST',
        handles: {
            open(type, object){
                table.set(next, { type, object });
                next += 4;
                return next - 4;
            },
            resolve(handle, type){
                const entry = table.get(handle);
                if (!entry || (type && entry.type !== type))
                {
                    throw new Error('bad handle');
                }
                return entry.object;
            },
            close(handle){
                return table.delete(handle);
            },
        },
    }));
    return { bytes, errors, fns, table };
}

test('a source is registered, reported to and let go', ()=>{
    const { bytes, errors, fns, table } = setup();
    bytes.set([...'IDriver\0'].map(character=>character.charCodeAt(0)), 0x100);
    const log = fns.RegisterEventSourceA.handler([0, 0x100]);
    assert.notEqual(log, 0);
    assert.equal(table.get(log)?.object.source, 'IDriver', 'the name is kept for the handle');
    assert.equal(fns.ReportEventA.handler([log, 1, 0, 0x1000, 0, 0, 0, 0, 0]), 1);
    assert.equal(fns.DeregisterEventSource.handler([log]), 1);
    assert.equal(table.has(log), false);
    assert.equal(fns.DeregisterEventSource.handler([log]), 0, 'once');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.ReportEventA.handler([log, 1, 0, 0x1000, 0, 0, 0, 0, 0]), 0,
        'and not reported to after');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});

test('a source without a name is refused, the wide form reads UTF-16, calls are stdcall',
    ()=>{
        const { bytes, errors, fns, table } = setup();
        assert.equal(fns.RegisterEventSourceA.handler([0, 0]), 0);
        assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
        bytes.set([0x41, 0, 0x42, 0, 0, 0], 0x200);
        const log = fns.RegisterEventSourceW.handler([0, 0x200]);
        assert.equal(table.get(log)?.object.source, 'AB');
        assert.deepEqual([fns.RegisterEventSourceA.argBytes, fns.DeregisterEventSource.argBytes,
            fns.ReportEventA.argBytes, fns.ReportEventW.argBytes], [8, 4, 36, 36]);
    });

test('an event reported is read back as an EVENTLOGRECORD, oldest first, then the end', ()=>{
    const { bytes, errors, fns } = setup();
    const view = new DataView(bytes.buffer);
    bytes.set([...'MySource\0'].map(character=>character.charCodeAt(0)), 0x100);
    bytes.set([...'hello\0'].map(character=>character.charCodeAt(0)), 0x140);
    view.setUint32(0x180, 0x140, true);
    const log = fns.RegisterEventSourceA.handler([0, 0x100]);
    assert.equal(fns.ReportEventA.handler([log, 2, 7, 42, 0, 1, 0, 0x180, 0]), 1);
    const reader = fns.OpenEventLogA.handler([0, 0x100]);
    view.setUint32(0x300, 0, true);
    assert.equal(fns.GetNumberOfEventLogRecords.handler([reader, 0x300]), 1);
    assert.equal(view.getUint32(0x300, true), 1, 'an unknown source writes to Application');
    const READ = 0x304;
    const NEEDED = 0x308;
    assert.equal(fns.ReadEventLogA.handler([reader, 5, 0, 0x400, 8, READ, NEEDED]), 0);
    assert.equal(errors.at(-1), 122);
    const length = view.getUint32(NEEDED, true);
    assert.equal(fns.ReadEventLogA.handler([reader, 5, 0, 0x400, 0x400, READ, NEEDED]), 1);
    assert.equal(view.getUint32(READ, true), length);
    assert.deepEqual([view.getUint32(0x400, true), view.getUint32(0x404, true),
        view.getUint32(0x408, true), view.getUint32(0x414, true), view.getUint16(0x418, true),
        view.getUint16(0x41a, true), view.getUint16(0x41c, true)],
    [length, 0x654c664c, 1, 42, 2, 1, 7], 'length, signature, number, id, type, strings, category');
    assert.equal(view.getUint32(0x400 + length - 4, true), length, 'the length again at its end');
    const strings = 0x400 + view.getUint32(0x424, true);
    assert.equal(String.fromCharCode(...bytes.subarray(strings, strings + 5)), 'hello');
    assert.equal(fns.ReadEventLogA.handler([reader, 5, 0, 0x400, 0x400, READ, NEEDED]), 0);
    assert.equal(errors.at(-1), 38, 'ERROR_HANDLE_EOF');
    assert.equal(fns.ReadEventLogA.handler([reader, 3, 0, 0x400, 0x400, READ, NEEDED]), 0,
        'sequential and seek at once');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.ClearEventLogA.handler([reader, 0]), 1);
    fns.GetNumberOfEventLogRecords.handler([reader, 0x300]);
    assert.equal(view.getUint32(0x300, true), 0);
});

test('the System log opens on its service\'s start, whatever the case of its name', ()=>{
    const { bytes, fns } = setup();
    const view = new DataView(bytes.buffer);
    bytes.set([...'SYSTEM\0'].map(character=>character.charCodeAt(0)), 0x100);
    const log = fns.OpenEventLogA.handler([0, 0x100]);
    assert.equal(fns.ReadEventLogA.handler([log, 9, 0, 0x400, 0x400, 0x304, 0x308]), 1);
    assert.equal(view.getUint32(0x414, true), 0x80001775, 'EVENT_EventlogStarted');
    assert.equal(view.getUint32(0x430, true), 24, 'its 24 bytes of data');
});

test('a trace session starts once under its name, and the kernel logger only as itself', ()=>{
    const { bytes, fns } = setup();
    const view = new DataView(bytes.buffer);
    const properties = 0x400;
    bytes.fill(0, properties, properties + 140);
    view.setUint32(properties, 140, true);
    view.setUint32(properties + 112, 120, true);
    view.setUint32(properties + 108, 128, true);
    bytes.set([...'wine\0'].map(character=>character.charCodeAt(0)), 0x100);
    // {9e814aad-3204-11d2-9a82-006008a86939}, laid out as a GUID is.
    bytes.set([0xad, 0x4a, 0x81, 0x9e, 0x04, 0x32, 0xd2, 0x11, 0x9a, 0x82, 0x00, 0x60, 0x08,
        0xa8, 0x69, 0x39], properties + 24);
    assert.equal(fns.StartTraceA.handler([0x300, 0x100, properties]), 87);
    bytes.fill(0, properties + 24, properties + 40);
    assert.equal(fns.StartTraceA.handler([0x300, 0x100, properties]), 0);
    assert.equal(fns.StartTraceA.handler([0x300, 0x100, properties]), 183, 'already there');
    assert.equal(fns.ControlTraceA.handler([view.getUint32(0x300, true), 0, 0x100, properties, 1]),
        0);
    assert.equal(fns.StartTraceA.handler([0x300, 0x100, properties]), 0, 'stopped, it starts');
});
