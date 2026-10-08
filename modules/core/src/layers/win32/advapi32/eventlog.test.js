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
    const bytes = new Uint8Array(0x400);
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

test('a source is registered, reported to and let go, and the event is forgotten', ()=>{
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
