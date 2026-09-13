/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMINISTRATORS_SID, createTokenFunctions } from './tokens.js';

const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_TOKEN = 1008;
const ERROR_INVALID_HANDLE = 6;
const TOKEN_QUERY = 8;
const TokenUser = 1;
const TokenGroups = 2;
const CURRENT_THREAD = 0xfffffffe;
const CURRENT_PROCESS = 0xffffffff;

const OUT = 0x100;
const NEEDED = 0x104;
const BUFFER = 0x200;
const SID = 0x600;

function setup(){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let next = 4;
    const fns = createTokenFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
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
        },
    });
    /** @param {number} at */
    const dword = at=>new DataView(bytes.buffer).getUint32(at, true);
    return { bytes, errors, table, fns, dword };
}

test('the sequence an installer asks whether it is an administrator with', ()=>{
    // OpenThreadToken has to fail with ERROR_NO_TOKEN and nothing else: that
    // is the code the program tests before it falls back to the process's
    // token, and any other failure is read as "not privileged".
    const { bytes, errors, fns, dword, table } = setup();

    assert.equal(fns.OpenThreadToken.handler([CURRENT_THREAD, TOKEN_QUERY, 0, OUT]), 0);
    assert.deepEqual(errors, [ERROR_NO_TOKEN]);

    assert.equal(fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 1);
    const token = dword(OUT);
    assert.equal(table.get(token)?.type, 'token', 'a real handle, closed like any other');

    // Sized first, then read: the first call fails saying how much is needed.
    assert.equal(fns.GetTokenInformation.handler([token, TokenGroups, 0, 0, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    const needed = dword(NEEDED);
    assert.ok(needed > 4 + 8 * 2, 'more than a count and two entries');

    assert.equal(fns.GetTokenInformation.handler([token, TokenGroups, BUFFER, needed, NEEDED]), 1);
    const count = dword(BUFFER);
    assert.ok(count >= 2);
    let admin = false;
    for (let at = 0; at < count; at++)
    {
        const sid = dword(BUFFER + 4 + at * 8);
        assert.ok(sid >= BUFFER && sid < BUFFER + needed, 'every SID lies inside the buffer given');
        assert.equal(dword(BUFFER + 4 + at * 8 + 4) & 0x4, 0x4, 'and is enabled');
        bytes.set(ADMINISTRATORS_SID, SID);
        if (fns.EqualSid.handler([SID, sid]) === 1)
        {
            admin = true;
        }
    }
    assert.equal(admin, true, 'BUILTIN\\Administrators is among the groups');

    assert.equal(fns.GetTokenInformation.handler([token, TokenUser, BUFFER, 0x100, NEEDED]), 1);
    assert.equal(dword(BUFFER), BUFFER + 8, 'the user SID follows its SID_AND_ATTRIBUTES');
    assert.deepEqual([...bytes.subarray(BUFFER + 8, BUFFER + 16)], [1, 5, 0, 0, 0, 0, 0, 5],
        'revision, five sub-authorities, the NT authority');

    assert.equal(fns.GetTokenInformation.handler([0x1234, TokenGroups, BUFFER, 0x100, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});

test('a SID is laid out as Windows lays it out, and compared by its own length', ()=>{
    const { bytes, fns } = setup();
    assert.deepEqual([...ADMINISTRATORS_SID],
        [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 0x02, 0, 0], 'S-1-5-32-544');
    bytes.set(ADMINISTRATORS_SID, SID);
    bytes.set(ADMINISTRATORS_SID, SID + 0x40);
    bytes[SID + 0x40 + 12] = 0x21;
    assert.equal(fns.EqualSid.handler([SID, SID + 0x40]), 0, 'S-1-5-32-545 is not the same');
    bytes[SID + 0x40 + 12] = 0x20;
    assert.equal(fns.EqualSid.handler([SID, SID + 0x40]), 1);
    assert.equal(fns.GetLengthSid.handler([SID]), 16);
});
