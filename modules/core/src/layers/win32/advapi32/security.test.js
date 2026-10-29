/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityFunctions } from './security.js';
import { createLsaFunctions } from './lsa.js';

/* The contract's numbers, restated so a wrong constant in the module cannot
 * hide behind the test importing it. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_SUCH_PRIVILEGE = 1313;
const ERROR_INVALID_SID = 1337;
const ERROR_BAD_DESCRIPTOR_FORMAT = 1361;
const ERROR_NON_DOMAIN_SID = 1258;
const ERROR_NOACCESS = 998;
const WinInteractiveSid = 11;
const WinAccountAdministratorSid = 38;
const WinLocalSystemSid = 22;
const WinLogonIdsSid = 21;
const TRUSTEE_IS_OBJECTS_AND_SID = 3;
const SE_DACL_PROTECTED = 0x1000;
const SE_DACL_PRESENT = 0x4;
const SE_SELF_RELATIVE = 0x8000;
const STATUS_SOME_NOT_MAPPED = 0x107;
const STATUS_NONE_MAPPED = 0xc0000073;
const STATUS_NO_SUCH_PRIVILEGE = 0xc0000060;
const SidTypeWellKnownGroup = 5;
const SidTypeUnknown = 8;

function setup(){
    const memory = new Uint8Array(0x40000);
    const view = new DataView(memory.buffer);
    let next = 0x20000;
    let error = 0;
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
            error = code;
        },
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += bytes + 7 & ~7;
            return at;
        },
    };
    /** @type {Record<string, { handler: (args: number[]) => number }>} */
    const fns = { ...createSecurityFunctions(host), ...createLsaFunctions(host) };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>fns[name].handler(args);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const text = at=>host.readCString(at, 4096);
    /** @param {number} at  An LSA_UNICODE_STRING. */
    const unicode = at=>{
        let out = '';
        const buffer = u32(at + 4);
        for (let i = 0; i < view.getUint16(at, true); i += 2)
        {
            out += String.fromCharCode(view.getUint16(buffer + i, true));
        }
        return out;
    };
    /** @param {number} at @param {string} value */
    const putText = (at, value)=>{
        memory.set([...value].map(c=>c.charCodeAt(0)).concat(0), at);
    };
    /** @param {number} at @param {string} value  An LSA_UNICODE_STRING and its text at +16. */
    const putUnicode = (at, value)=>{
        view.setUint16(at, value.length * 2, true);
        view.setUint16(at + 2, value.length * 2, true);
        put32(at + 4, at + 16);
        [...value].forEach((c, i)=>view.setUint16(at + 16 + i * 2, c.charCodeAt(0), true));
    };
    return { memory, call, u32, put32, text, putText, putUnicode, unicode,
        error: ()=>error, clear: ()=>{
            error = 0xdeadbeef;
        } };
}

const SID = 0x1000;
const SID2 = 0x1100;
const SIZE = 0x1200;
const OUT = 0x1210;
const DOMAIN = 0x1300;
const TEXT = 0x1400;

test('CreateWellKnownSid answers the size first; a domain one takes the domain given', ()=>{
    const { call, u32, put32, error, memory } = setup();
    put32(SIZE, 0);
    assert.equal(call('CreateWellKnownSid', WinInteractiveSid, 0, 0, SIZE), 0);
    assert.equal(error(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(u32(SIZE), 12);
    assert.equal(call('CreateWellKnownSid', WinInteractiveSid, 0, 0, SIZE), 0,
        'the size fits, but there is no buffer');
    assert.equal(error(), ERROR_INVALID_PARAMETER);
    assert.equal(call('CreateWellKnownSid', WinInteractiveSid, 0, SID, SIZE), 1);
    assert.equal(call('GetSidLengthRequired', 1), 12);

    // S-1-5-21-12-23-34-45-56: the test's domain, six sub-authorities kept as given.
    const domain = [1, 6, 0, 0, 0, 0, 0, 5, ...[21, 12, 23, 34, 45, 56]
        .flatMap(n=>[n, 0, 0, 0])];
    memory.set(domain, DOMAIN);
    put32(SIZE, 68);
    assert.equal(call('CreateWellKnownSid', WinAccountAdministratorSid, 0, SID, SIZE), 0,
        'a domain account needs its domain');
    assert.equal(call('CreateWellKnownSid', WinAccountAdministratorSid, DOMAIN, SID, SIZE), 1);
    assert.equal(u32(SIZE), 8 + 4 * 7);
    assert.equal(u32(SID + 8 + 4 * 6), 500);
    assert.equal(call('IsWellKnownSid', SID, WinAccountAdministratorSid), 0,
        'six sub-authorities is not an account domain');

    put32(SIZE, 68);
    assert.equal(call('CreateWellKnownSid', WinLocalSystemSid, DOMAIN, SID, SIZE), 1,
        'the domain is ignored for a SID with none');
    assert.equal(call('IsWellKnownSid', SID, WinLocalSystemSid), 1);
});

test('IsWellKnownSid takes any logon session for WinLogonIdsSid', ()=>{
    const { call, memory } = setup();
    memory.set([1, 3, 0, 0, 0, 0, 0, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0x21, 0x43, 0, 0], SID);
    assert.equal(call('IsWellKnownSid', SID, WinLogonIdsSid), 1);
});

test('EqualDomainSid compares the built-in domain and refuses a SID in no domain', ()=>{
    const { call, u32, memory, error } = setup();
    memory.set([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0], SID); // S-1-5-32-544
    memory.set([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x21, 2, 0, 0], SID2); // S-1-5-32-545
    assert.equal(call('EqualDomainSid', SID, SID2, OUT), 1);
    assert.equal(u32(OUT), 1);
    memory.set([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0], SID2); // S-1-5-18
    assert.equal(call('EqualDomainSid', SID, SID2, OUT), 0);
    assert.equal(error(), ERROR_NON_DOMAIN_SID);
    assert.equal(call('EqualDomainSid', 0, 0, 0), 0);
    assert.equal(error(), ERROR_INVALID_SID);
});

test('GetWindowsAccountDomainSid is S-1-5-21 and the three numbers after it', ()=>{
    const { call, u32, put32, memory, error } = setup();
    const subs = [21, 7, 8, 9, 1000].flatMap(n=>[n & 0xff, n >> 8, 0, 0]);
    memory.set([1, 5, 0, 0, 0, 0, 0, 5, ...subs], SID);
    put32(SIZE, 1);
    assert.equal(call('GetWindowsAccountDomainSid', SID, SID2, SIZE), 0);
    assert.equal(error(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(u32(SIZE), 24);
    assert.equal(call('GetWindowsAccountDomainSid', SID, SID2, SIZE), 1);
    assert.deepEqual([...memory.subarray(SID2, SID2 + 24)], [...memory.subarray(SID, SID + 24)]
        .map((byte, at)=>(at === 1 ? 4 : byte)));
});

test('LookupPrivilegeName asks for the terminator, and answers the length without it', ()=>{
    const { call, u32, put32, text, error } = setup();
    put32(SID, 2);
    put32(SID + 4, 0);
    put32(SIZE, 0);
    assert.equal(call('LookupPrivilegeNameA', 0, SID, 0, SIZE), 0);
    assert.equal(error(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(u32(SIZE), 'SeCreateTokenPrivilege'.length + 1);
    put32(SIZE, 64);
    assert.equal(call('LookupPrivilegeNameA', 0, SID, TEXT, SIZE), 1);
    assert.equal(text(TEXT), 'SeCreateTokenPrivilege');
    assert.equal(u32(SIZE), 'SeCreateTokenPrivilege'.length);
    put32(SID, 0xdeadbeef);
    assert.equal(call('LookupPrivilegeNameA', 0, SID, TEXT, SIZE), 0);
    assert.equal(error(), ERROR_NO_SUCH_PRIVILEGE);
});

test('AllocateLocallyUniqueId hands out distinct LUIDs above the privileges', ()=>{
    const { call, u32, error } = setup();
    assert.equal(call('AllocateLocallyUniqueId', OUT), 1);
    const first = u32(OUT);
    assert.equal(call('AllocateLocallyUniqueId', OUT), 1);
    assert.ok(first > 30);
    assert.notEqual(u32(OUT), first);
    assert.equal(call('AllocateLocallyUniqueId', 0), 0);
    assert.equal(error(), ERROR_NOACCESS);
});

test('a trustee built with objects and a SID points at the filled OBJECTS_AND_SID', ()=>{
    const { call, u32, memory } = setup();
    const trustee = 0x2000;
    const objects = 0x2100;
    const guid = 0x2200;
    memory.fill(0xff, trustee, trustee + 20);
    memory.fill(0xff, objects, objects + 40);
    memory.fill(0x11, guid, guid + 16);
    call('BuildTrusteeWithObjectsAndSidA', trustee, objects, 0, guid, SID);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>u32(trustee + at)),
        [0, 0, TRUSTEE_IS_OBJECTS_AND_SID, 0, objects]);
    assert.equal(u32(objects), 2, 'only the inherited type is present');
    assert.ok(memory.subarray(objects + 4, objects + 20).every(byte=>byte === 0));
    assert.ok(memory.subarray(objects + 20, objects + 36).every(byte=>byte === 0x11));
    assert.equal(u32(objects + 36), SID);
    assert.equal(call('GetTrusteeNameA', trustee), objects);
});

/** An absolute descriptor with an owner and an empty, present DACL. */
function absoluteDescriptor(/** @type {ReturnType<typeof setup>} */ env){
    const sd = 0x3000;
    const acl = 0x3100;
    env.memory.fill(0, sd, sd + 20);
    env.memory[sd] = 1;
    env.memory.set([2, 0, 8, 0, 0, 0, 0, 0], acl);
    env.memory.set([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0], SID); // S-1-5-18
    env.put32(sd + 4, SID);
    env.put32(sd + 16, acl);
    env.memory[sd + 2] = SE_DACL_PRESENT;
    return sd;
}

test('SetSecurityDescriptorControl changes only the free bits, and refuses the rest whole', ()=>{
    const env = setup();
    const sd = absoluteDescriptor(env);
    assert.equal(env.call('SetSecurityDescriptorControl', sd, SE_DACL_PROTECTED,
        SE_DACL_PROTECTED), 1);
    assert.equal(env.memory[sd + 2] | env.memory[sd + 3] << 8, SE_DACL_PRESENT | SE_DACL_PROTECTED);
    env.clear();
    assert.equal(env.call('SetSecurityDescriptorControl', sd, SE_DACL_PROTECTED,
        SE_DACL_PROTECTED | SE_SELF_RELATIVE), 0);
    assert.equal(env.error(), ERROR_INVALID_PARAMETER);
    assert.equal(env.memory[sd + 2] | env.memory[sd + 3] << 8, SE_DACL_PRESENT | SE_DACL_PROTECTED);
});

test('a descriptor goes self-relative and back, each form refusing the other call', ()=>{
    const env = setup();
    const sd = absoluteDescriptor(env);
    const relative = 0x4000;
    env.put32(SIZE, 5);
    assert.equal(env.call('MakeSelfRelativeSD', sd, relative, SIZE), 0);
    assert.equal(env.error(), ERROR_INSUFFICIENT_BUFFER);
    const needed = env.u32(SIZE);
    assert.equal(needed, 20 + 8 + 12);
    env.put32(SIZE, needed + 4);
    assert.equal(env.call('MakeSelfRelativeSD', sd, relative, SIZE), 1);
    assert.equal(env.u32(SIZE), needed + 4, 'a fit leaves the length as it was');
    assert.equal(env.call('MakeSelfRelativeSD', relative, 0x5000, SIZE), 0);
    assert.equal(env.error(), ERROR_BAD_DESCRIPTOR_FORMAT);

    const sizes = [0x4800, 0x4804, 0x4808, 0x480c, 0x4810];
    sizes.forEach(at=>env.put32(at, 0));
    assert.equal(env.call('MakeAbsoluteSD', relative, 0, sizes[0], 0, sizes[1], 0, sizes[2], 0,
        sizes[3], 0, sizes[4]), 0);
    assert.equal(env.error(), ERROR_INSUFFICIENT_BUFFER);
    assert.deepEqual(sizes.map(env.u32), [20, 8, 0, 12, 0]);
    assert.equal(env.call('MakeAbsoluteSD', relative, 0x6000, sizes[0], 0x6100, sizes[1], 0,
        sizes[2], 0x6200, sizes[3], 0, sizes[4]), 1);
    assert.equal(env.u32(0x6000 + 4), 0x6200);
    assert.equal(env.u32(0x6000 + 16), 0x6100);
    assert.equal(env.memory[0x6000 + 3] & 0x80, 0, 'absolute again');
});

test('a descriptor converts to SDDL: SIDs by their two letters, rights by name or in hex', ()=>{
    const env = setup();
    const sd = absoluteDescriptor(env);
    // One allowed ACE, no-propagate, generic all|execute|write|read, to S-1-5-6 (SU).
    env.memory.set([2, 0, 28, 0, 1, 0, 0, 0, 0, 4, 20, 0, 0, 0, 0, 0xf0,
        1, 1, 0, 0, 0, 0, 0, 5, 6, 0, 0, 0], 0x3100);
    assert.equal(env.call('ConvertSecurityDescriptorToStringSecurityDescriptorA', sd, 1, 0xf,
        OUT, SIZE), 1);
    const expected = 'O:SYD:(A;NP;GAGXGWGR;;;SU)';
    assert.equal(env.text(env.u32(OUT)), expected);
    assert.equal(env.u32(SIZE), expected.length + 1);
    env.put32(sd + 16, 0);
    assert.equal(env.call('ConvertSecurityDescriptorToStringSecurityDescriptorA', sd, 1, 4,
        OUT, SIZE), 1);
    assert.equal(env.text(env.u32(OUT)), 'D:NO_ACCESS_CONTROL', 'a null DACL');
});

test('GetPrivateObjectSecurity keeps only the parts asked for, self-relative', ()=>{
    const env = setup();
    const sd = absoluteDescriptor(env);
    assert.equal(env.call('GetPrivateObjectSecurity', sd, 1, 0x7000, 3, SIZE), 0);
    assert.equal(env.error(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(env.u32(SIZE), 20 + 12);
    assert.equal(env.call('GetPrivateObjectSecurity', sd, 1, 0x7000, 64, SIZE), 1);
    assert.equal(env.memory[0x7001 + 1] | env.memory[0x7001 + 2] << 8, SE_SELF_RELATIVE);
});

test('GetExplicitEntriesFromAcl gives a grant per allowed ACE, and NULL for none', ()=>{
    const env = setup();
    const acl = 0x3100;
    env.memory.set([2, 0, 28, 0, 1, 0, 0, 0, 0, 0, 20, 0, 0x19, 0, 2, 0,
        1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], acl);
    assert.equal(env.call('GetExplicitEntriesFromAclW', acl, SIZE, OUT), 0);
    assert.equal(env.u32(SIZE), 1);
    const entry = env.u32(OUT);
    assert.deepEqual([0, 4, 8, 20, 24].map(at=>env.u32(entry + at)), [0x20019, 1, 0, 0, 0]);
    assert.deepEqual([...env.memory.subarray(env.u32(entry + 28), env.u32(entry + 28) + 12)],
        [1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    env.memory.set([2, 0, 8, 0, 0, 0, 0, 0], acl);
    assert.equal(env.call('GetExplicitEntriesFromAclW', acl, SIZE, OUT), 0);
    assert.equal(env.u32(SIZE), 0);
    assert.equal(env.u32(OUT), 0);
});

test('LsaLookupNames2 maps a service account by its spaced name, and says what it could not', ()=>{
    const env = setup();
    const attributes = 0x8000;
    assert.equal(env.call('LsaOpenPolicy', 0, attributes, 0, OUT), 0);
    const policy = env.u32(OUT);
    env.putUnicode(0x8100, 'NT AUTHORITY\\LocalService');
    env.putUnicode(0x8200, 'LOCAL SERVIC');
    assert.equal(env.call('LsaLookupNames2', policy, 0, 1, 0x8100, DOMAIN, SID), 0);
    const sids = env.u32(SID);
    assert.equal(env.u32(sids), SidTypeWellKnownGroup);
    assert.equal(env.u32(env.u32(DOMAIN)), 1, 'one domain referenced');
    assert.equal(env.unicode(env.u32(env.u32(DOMAIN) + 4)), 'NT AUTHORITY');

    // Two names in one call, an array of LSA_UNICODE_STRINGs: one maps, one does not.
    const names = 0x8400;
    env.memory.copyWithin(names, 0x8100, 0x8108);
    env.memory.copyWithin(names + 8, 0x8200, 0x8208);
    assert.equal(env.call('LsaLookupNames2', policy, 0, 2, names, DOMAIN, SID),
        STATUS_SOME_NOT_MAPPED);
    assert.equal(env.u32(env.u32(SID) + 16), SidTypeUnknown);
    assert.equal(env.call('LsaLookupNames2', policy, 0, 1, 0x8200, DOMAIN, SID),
        STATUS_NONE_MAPPED);
});

test('LsaLookupPrivilegeName knows the privileges by LUID, with a NULL name for none', ()=>{
    const env = setup();
    env.call('LsaOpenPolicy', 0, 0x8000, 0, OUT);
    const policy = env.u32(OUT);
    env.put32(SID, 2);
    env.put32(SID + 4, 1);
    env.put32(TEXT, 0xdeadbeef);
    assert.equal(env.call('LsaLookupPrivilegeName', policy, SID, TEXT), STATUS_NO_SUCH_PRIVILEGE);
    assert.equal(env.u32(TEXT), 0);
    env.put32(SID + 4, 0);
    assert.equal(env.call('LsaLookupPrivilegeName', policy, SID, TEXT), 0);
    assert.equal(env.unicode(env.u32(TEXT)), 'SeCreateTokenPrivilege');
});
