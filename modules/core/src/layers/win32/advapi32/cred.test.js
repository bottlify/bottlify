/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredFunctions, unmarshal } from './cred.js';
import { createPerfFunctions } from './perf.js';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_FLAGS = 1004;
const ERROR_NOT_FOUND = 1168;
const ERROR_BAD_USERNAME = 2202;
const ERROR_ALREADY_EXISTS = 183;
const CRED_TYPE_GENERIC = 1;
const CRED_TYPE_DOMAIN_PASSWORD = 2;
const CRED_PERSIST_SESSION = 1;
const CRED_PERSIST_ENTERPRISE = 3;

function setup(){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let next = 0x10000;
    /** @type {number[]} */
    const errors = [];
    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>memory.subarray(at, at + length),
        /** @param {number} at @param {Uint8Array} bytes */
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        /** @param {number} at @param {number} max */
        readCString: (at, max)=>{
            let text = '';
            for (let i = 0; i < max && memory[at + i] !== 0; i++)
            {
                text += String.fromCharCode(memory[at + i]);
            }
            return text;
        },
        /** @param {number} code */
        setLastError: code=>{
            errors.push(code);
        },
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += bytes + 7 & ~7;
            return at;
        },
    };
    /** @type {Record<string, { handler: (args: number[]) => any }>} */
    const fns = { ...createCredFunctions(host), ...createPerfFunctions(host) };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>fns[name].handler(args);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at @param {string} text */
    const putText = (at, text)=>memory.set([...text].map(c=>c.charCodeAt(0)).concat(0), at);
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>[...text, '\0'].forEach((c, i)=>view.setUint16(at + i * 2,
        c.charCodeAt(0), true));
    return { memory, call, u32, put32, putText, putWide, text: (/** @type {number} */ at)=>
        host.readCString(at, 256), errors };
}

const CRED = 0x100;
const TARGET = 0x200;
const USER = 0x240;
const BLOB = 0x280;
const OUT = 0x300;
const COUNT = 0x304;

/** A CREDENTIALA at CRED: its type, target, user, a four-byte blob and how long it lasts. */
/**
 * @param {ReturnType<typeof setup>} env @param {number} type @param {string | null} user
 * @param {number} persist
 */
function credential(env, type, user, persist){
    env.memory.fill(0, CRED, CRED + 52);
    env.put32(CRED + 4, type);
    env.putText(TARGET, 'credtest.example');
    env.put32(CRED + 8, TARGET);
    env.memory.set([1, 2, 3, 4], BLOB);
    env.put32(CRED + 24, 4);
    env.put32(CRED + 28, BLOB);
    env.put32(CRED + 32, persist);
    if (user !== null)
    {
        env.putText(USER, user);
        env.put32(CRED + 48, USER);
    }
}

test('a credential is written, read back with its blob, listed and deleted', ()=>{
    const env = setup();
    credential(env, CRED_TYPE_GENERIC, 'winetest', CRED_PERSIST_SESSION);
    assert.equal(env.call('CredWriteA', CRED, 0), 1);
    assert.equal(env.call('CredReadA', TARGET, CRED_TYPE_GENERIC, 0, OUT), 1);
    const read = env.u32(OUT);
    assert.equal(env.text(env.u32(read + 8)), 'credtest.example');
    assert.equal(env.u32(read + 24), 4);
    assert.deepEqual([...env.memory.subarray(env.u32(read + 28), env.u32(read + 28) + 4)],
        [1, 2, 3, 4]);
    assert.equal(env.text(env.u32(read + 48)), 'winetest');
    assert.equal(env.call('CredEnumerateA', 0, 0, COUNT, OUT), 1);
    assert.equal(env.u32(COUNT), 1);
    assert.equal(env.call('CredDeleteA', TARGET, CRED_TYPE_GENERIC, 0), 1);
    assert.equal(env.call('CredReadA', TARGET, CRED_TYPE_GENERIC, 0, OUT), 0);
    assert.equal(env.errors.at(-1), ERROR_NOT_FOUND);
    assert.equal(env.call('CredEnumerateA', 0, 0, COUNT, OUT), 0);
});

test('a domain password needs an account, and is never read back', ()=>{
    const env = setup();
    credential(env, CRED_TYPE_DOMAIN_PASSWORD, null, CRED_PERSIST_ENTERPRISE);
    assert.equal(env.call('CredWriteA', CRED, 0), 0);
    assert.equal(env.errors.at(-1), ERROR_BAD_USERNAME);
    credential(env, CRED_TYPE_DOMAIN_PASSWORD, 'test\\winetest', CRED_PERSIST_ENTERPRISE);
    assert.equal(env.call('CredWriteA', CRED, 0), 1);
    assert.equal(env.call('CredReadA', TARGET, CRED_TYPE_DOMAIN_PASSWORD, 0, OUT), 1);
    assert.equal(env.u32(env.u32(OUT) + 24), 0);
    assert.equal(env.u32(env.u32(OUT) + 28), 0);
    assert.equal(env.call('CredReadA', TARGET, CRED_TYPE_DOMAIN_PASSWORD, 1, OUT), 0);
    assert.equal(env.errors.at(-1), ERROR_INVALID_FLAGS);
    assert.equal(env.call('CredReadA', TARGET, 99, 0, OUT), 0);
    assert.equal(env.errors.at(-1), ERROR_INVALID_PARAMETER);
});

test('a user name marshals to the text Windows writes, and back', ()=>{
    const env = setup();
    env.putWide(0x400, 'test');
    env.put32(0x500, 0x400);
    assert.equal(env.call('CredMarshalCredentialA', 2, 0x500, OUT), 1);
    assert.equal(env.text(env.u32(OUT)), '@@CIAAAAA0BQZAMHA0BA');
    assert.deepEqual(unmarshal('@@CIAAAAA0BQZAMHA0BA'), { kind: 2, user: 'test' });
    assert.deepEqual(unmarshal('@@CEAAAAA0BAd'), { kind: 2 }, 'too short for its length');
    assert.deepEqual(unmarshal('@@E'), { kind: 4 });
    env.putText(0x600, '@@BXlmblBAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(env.call('CredIsMarshaledCredentialA', 0x600), 1);
    assert.equal(env.call('CredUnmarshalCredentialA', 0x600, COUNT, OUT), 1);
    assert.equal(env.u32(COUNT), 1);
    assert.deepEqual([...env.memory.subarray(env.u32(OUT) + 4, env.u32(OUT) + 9)],
        [...'Wine'].map(c=>c.charCodeAt(0)).concat(0));
});

test('a certificate hash marshals six bits to a character, lowest first', ()=>{
    const env = setup();
    env.memory.fill(0, 0x700, 0x700 + 24);
    env.put32(0x700, 24);
    env.memory[0x704] = 255;
    assert.equal(env.call('CredMarshalCredentialA', 1, 0x700, OUT), 1);
    assert.equal(env.text(env.u32(OUT)), '@@B-DAAAAAAAAAAAAAAAAAAAAAAAAA');
    env.put32(0x700, 0);
    assert.equal(env.call('CredMarshalCredentialA', 1, 0x700, OUT), 0);
});

test('a performance counter set takes values of its own size, in place', ()=>{
    const env = setup();
    env.memory.fill(7, 0x800, 0x810);
    assert.equal(env.call('PerfStartProvider', 0x800, 0, OUT), 0);
    const provider = env.u32(OUT);
    // A set of two DWORD counters held by value: ids 1 and 2.
    const template = 0x900;
    env.memory.fill(0, template, template + 104);
    env.memory.fill(9, template, template + 16);
    env.put32(template + 32, 2);
    env.put32(template + 40, 1);
    env.put32(template + 72, 2);
    assert.equal(env.call('PerfSetCounterSetInfo', provider, template, 104), 0);
    assert.equal(env.call('PerfSetCounterSetInfo', provider, template, 104), ERROR_ALREADY_EXISTS);
    env.putWide(0xa00, '11');
    const instance = env.call('PerfCreateInstance', provider, template, 0xa00, 1);
    assert.notEqual(instance, 0);
    assert.equal(env.u32(instance + 24), 32 + 16, 'the name after two counters');
    assert.equal(env.u32(instance + 16), 32 + 16 + 8);
    assert.equal(env.call('PerfSetULongCounterValue', provider, instance, 2, 900000), 0);
    assert.equal(env.u32(instance + 40), 900000);
    assert.equal(env.call('PerfSetULongLongCounterValue', provider, instance, 2, 1, 0),
        ERROR_INVALID_PARAMETER, 'not a large counter');
    assert.equal(env.call('PerfSetULongCounterValue', provider, instance, 3, 1), ERROR_NOT_FOUND);
    assert.equal(env.call('PerfSetCounterRefValue', provider, instance, 1, 0x1234),
        ERROR_INVALID_PARAMETER, 'held by value');
    assert.equal(env.call('PerfDeleteInstance', provider, instance), 0);
    assert.equal(env.call('PerfStopProvider', provider), 0);
});
