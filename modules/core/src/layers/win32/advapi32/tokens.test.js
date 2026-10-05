/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMINISTRATORS_SID, TOKEN_NATIVES, createTokenFunctions } from './tokens.js';

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
    let heap = 0x800;
    const fns = createTokenFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        setLastError: code=>errors.push(code),
        allocate: size=>{
            const at = heap;
            heap += size + 7 & ~7;
            return at;
        },
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

test('DuplicateToken hands a second token handle with the level it was given', ()=>{
    const { errors, fns, dword, table } = setup();
    assert.equal(fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 1);
    const token = dword(OUT);

    assert.equal(fns.DuplicateToken.handler([token, 2, NEEDED]), 1);
    const duplicate = dword(NEEDED);
    assert.equal(table.get(duplicate)?.type, 'token');
    assert.notEqual(duplicate, token, 'a second handle, not the same one');
    assert.equal(table.get(duplicate)?.object.impersonationLevel, 2);
    assert.equal(table.get(duplicate)?.object.process, CURRENT_PROCESS);

    assert.equal(fns.DuplicateToken.handler([0x1234, 2, NEEDED]), 0, 'not a token');
    assert.deepEqual(errors, [ERROR_INVALID_HANDLE]);
});

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
    // And it leaves the last error alone, as a call that succeeds does: the
    // program reads ERROR_NO_TOKEN back here to know the thread's token was
    // the one missing, and a zero written over it is read as "not privileged".
    assert.deepEqual(errors, [ERROR_NO_TOKEN]);

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

test('the owner, primary group, type and session of a token', ()=>{
    // An update package asks for the owner first and the user after it, and
    // copies each SID by its length; a class it is refused ends the package
    // with ERROR_INVALID_PARAMETER as its exit code.
    const TokenOwner = 4;
    const TokenPrimaryGroup = 5;
    const TokenType = 8;
    const TokenSessionId = 12;
    const ERROR_INVALID_PARAMETER = 87;
    const { bytes, errors, fns, dword } = setup();
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    const token = dword(OUT);

    assert.equal(fns.GetTokenInformation.handler([token, TokenOwner, 0, 0, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(dword(NEEDED), 4 + ADMINISTRATORS_SID.length, 'a pointer, then the SID');
    assert.equal(fns.GetTokenInformation.handler([token, TokenOwner, BUFFER, 0x100, NEEDED]), 1);
    assert.equal(dword(BUFFER), BUFFER + 4, 'the owner SID follows its pointer');
    assert.equal(fns.GetLengthSid.handler([dword(BUFFER)]), ADMINISTRATORS_SID.length);
    assert.deepEqual([...bytes.subarray(BUFFER + 4, BUFFER + 4 + ADMINISTRATORS_SID.length)],
        [...ADMINISTRATORS_SID], 'an administrator\'s objects are owned by the Administrators');

    assert.equal(fns.GetTokenInformation.handler([token, TokenPrimaryGroup, BUFFER, 0x100, NEEDED]),
        1);
    assert.equal(dword(BUFFER), BUFFER + 4);
    assert.equal(dword(BUFFER + 4 + 8 + 16), 513, 'the domain\'s users');

    assert.equal(fns.GetTokenInformation.handler([token, TokenType, BUFFER, 4, NEEDED]), 1);
    assert.deepEqual([dword(BUFFER), dword(NEEDED)], [1, 4], 'TokenPrimary');
    fns.DuplicateToken.handler([token, 2, OUT]);
    assert.equal(fns.GetTokenInformation.handler([dword(OUT), TokenType, BUFFER, 4, NEEDED]), 1);
    assert.equal(dword(BUFFER), 2, 'a duplicate impersonates');

    bytes.fill(0xff, BUFFER, BUFFER + 4);
    assert.equal(fns.GetTokenInformation.handler([token, TokenSessionId, BUFFER, 4, NEEDED]), 1);
    assert.equal(dword(BUFFER), 0, 'the console session');

    assert.equal(fns.GetTokenInformation.handler([token, 0x7f, BUFFER, 0x100, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'a class there is none of');
});

test('the native token calls open and adjust the same tokens, with statuses', ()=>{
    // An update package opens its token through ntdll to take the shutdown
    // privilege; the last error is not a native call's to touch.
    const { errors, fns, dword, table } = setup();
    const natives = fns[TOKEN_NATIVES];
    assert.equal(natives.NtOpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 0);
    const token = dword(OUT);
    assert.equal(table.get(token)?.type, 'token');
    assert.equal(natives.NtOpenProcessTokenEx.handler([CURRENT_PROCESS, TOKEN_QUERY, 0, NEEDED]),
        0);
    assert.notEqual(dword(NEEDED), token, 'a handle of its own');
    assert.equal(natives.NtOpenProcessToken.handler([0x1234, TOKEN_QUERY, OUT]), 0xc0000008,
        'STATUS_INVALID_HANDLE');
    assert.equal(natives.NtOpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, 0]), 0xc0000005,
        'nowhere to put it: STATUS_ACCESS_VIOLATION');

    assert.equal(natives.NtAdjustPrivilegesToken.handler([token, 0, BUFFER, 0x10, SID, NEEDED]), 0);
    assert.deepEqual([dword(SID), dword(NEEDED)], [0, 4], 'nothing was enabled before');
    assert.equal(natives.NtAdjustPrivilegesToken.handler([0x1234, 0, BUFFER, 0, 0, 0]), 0xc0000008);
    assert.deepEqual(errors, [], 'the last error is left alone');
    assert.deepEqual(Object.fromEntries(Object.entries(natives)
        .map(([name, entry])=>[name, entry.argBytes])),
    { NtOpenProcessToken: 12, NtOpenProcessTokenEx: 16, NtAdjustPrivilegesToken: 24 });
});

test('a privilege is looked up by its fixed number and granted on the process token', ()=>{
    // An archiver enables SeRestorePrivilege before it restores what it
    // unpacks; refused, it takes the path for a user who may not.
    const { bytes, errors, fns, dword } = setup();
    const NAME = 0x100;
    const LUID = 0x200;
    const TOKEN_OUT = 0x300;
    const STATE = 0x400;
    const PREVIOUS = 0x500;
    const LENGTH = 0x600;
    bytes.set([...'SeRestorePrivilege'].map(c=>c.charCodeAt(0)), NAME);

    assert.equal(fns.LookupPrivilegeValueA.handler([0, NAME, LUID]), 1);
    assert.equal(dword(LUID), 18);
    assert.equal(dword(LUID + 4), 0);
    bytes.set([...'SeNoSuchPrivilege\0'].map(c=>c.charCodeAt(0)), NAME);
    assert.equal(fns.LookupPrivilegeValueA.handler([0, NAME, LUID]), 0);
    assert.equal(errors.at(-1), 1313, 'ERROR_NO_SUCH_PRIVILEGE');

    assert.equal(fns.OpenProcessToken.handler([0xffffffff, 0x28, TOKEN_OUT]), 1);
    const token = dword(TOKEN_OUT);
    assert.equal(fns.AdjustTokenPrivileges.handler([token, 0, STATE, 16, PREVIOUS, LENGTH]), 1);
    assert.equal(errors.at(-1), 0, 'ERROR_SUCCESS: every privilege was assigned');
    assert.equal(dword(PREVIOUS), 0, 'nothing was enabled before');
    assert.equal(dword(LENGTH), 4);
    assert.equal(fns.AdjustTokenPrivileges.handler([0x7777, 0, STATE, 0, 0, 0]), 0);
    assert.equal(errors.at(-1), 6, 'ERROR_INVALID_HANDLE');
    assert.equal(fns.AdjustTokenPrivileges.argBytes, 24);
    assert.equal(fns.LookupPrivilegeValueA.argBytes, 12);
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

test('a SID is valid by its revision and count, and membership is asked in one call', ()=>{
    const { bytes, fns, dword } = setup();
    bytes.set(ADMINISTRATORS_SID, SID);
    assert.equal(fns.IsValidSid.handler([SID]), 1);
    bytes[SID + 0x40] = 2;
    assert.equal(fns.IsValidSid.handler([SID + 0x40]), 0, 'a revision nothing wrote');
    assert.equal(fns.IsValidSid.handler([0]), 0);

    const ANSWER = SID + 0x80;
    assert.equal(fns.CheckTokenMembership.handler([0, SID, ANSWER]), 1);
    assert.equal(dword(ANSWER), 1, 'the caller is an administrator');
    bytes.set(ADMINISTRATORS_SID, SID + 0x40);
    bytes[SID + 0x40 + 12] = 0x27;
    assert.equal(fns.CheckTokenMembership.handler([0, SID + 0x40, ANSWER]), 1);
    assert.equal(dword(ANSWER), 0, 'and not a backup operator');
    assert.equal(fns.CheckTokenMembership.handler([0x7777, SID, ANSWER]), 0,
        'a handle nothing opened');
    assert.equal(fns.CheckTokenMembership.argBytes, 12);
});

test('a DACL allowing only the administrators lets the one account in', ()=>{
    // The sample Microsoft published for "am I an administrator": a descriptor
    // whose DACL allows BUILTIN\Administrators a right, and AccessCheck with
    // the caller's token. Answered as the consumer Windows answered it, the
    // installer that asks refuses to run.
    const { bytes, errors, fns, dword } = setup();
    assert.equal(fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 1);
    const token = dword(OUT);

    const DESCRIPTOR = 0x300;
    const ACL_AT = 0x340;
    const MAPPING = 0x400;
    const PRIVILEGES = 0x420;
    const PRIVILEGES_LENGTH = 0x440;
    const GRANTED = 0x444;
    const STATUS = 0x448;
    const ACCESS_READ = 1;
    bytes.set(ADMINISTRATORS_SID, SID);
    const aclSize = 8 + 8 + ADMINISTRATORS_SID.length;

    assert.equal(fns.InitializeSecurityDescriptor.handler([DESCRIPTOR, 1]), 1);
    assert.equal(fns.InitializeAcl.handler([ACL_AT, aclSize, 2]), 1);
    assert.equal(fns.AddAccessAllowedAce.handler([ACL_AT, 2, ACCESS_READ, SID]), 1);
    assert.equal(fns.SetSecurityDescriptorDacl.handler([DESCRIPTOR, 1, ACL_AT, 0]), 1);
    assert.equal(fns.SetSecurityDescriptorGroup.handler([DESCRIPTOR, SID, 0]), 1);
    assert.equal(fns.SetSecurityDescriptorOwner.handler([DESCRIPTOR, SID, 0]), 1);
    assert.equal(fns.IsValidSecurityDescriptor.handler([DESCRIPTOR]), 1);
    new DataView(bytes.buffer).setUint32(MAPPING, ACCESS_READ, true);
    new DataView(bytes.buffer).setUint32(PRIVILEGES_LENGTH, 20, true);

    const check = ()=>fns.AccessCheck.handler([DESCRIPTOR, token, ACCESS_READ, MAPPING,
        PRIVILEGES, PRIVILEGES_LENGTH, GRANTED, STATUS]);
    assert.equal(check(), 1);
    assert.equal(dword(STATUS), 1, 'the administrator is let in');
    assert.equal(dword(GRANTED), ACCESS_READ);

    // A DACL that allows only a SID the account does not hold refuses it.
    bytes.set([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0], SID);   // S-1-5-18, LocalSystem
    assert.equal(fns.InitializeAcl.handler([ACL_AT, aclSize, 2]), 1);
    assert.equal(fns.AddAccessAllowedAce.handler([ACL_AT, 2, ACCESS_READ, SID]), 1);
    assert.equal(check(), 1, 'the check itself succeeds');
    assert.equal(dword(STATUS), 0);
    assert.equal(errors.at(-1), 5, 'ERROR_ACCESS_DENIED');

    // No room left for another ACE, and a revision no descriptor has.
    assert.equal(fns.AddAccessAllowedAce.handler([ACL_AT, 2, ACCESS_READ, SID]), 0);
    assert.equal(errors.at(-1), 1344, 'ERROR_ALLOTTED_SPACE_EXCEEDED');

    // AddAce puts ACEs already laid out in at an index, the rest moved up.
    const WIDE = 0x800;
    const aceSize = 8 + 12;
    assert.equal(fns.InitializeAcl.handler([WIDE, 8 + 2 * aceSize, 2]), 1);
    assert.equal(fns.AddAccessAllowedAce.handler([WIDE, 2, ACCESS_READ, SID]), 1);
    const denied = bytes.slice(WIDE + 8, WIDE + 8 + aceSize);
    denied[0] = 1;   // ACCESS_DENIED_ACE_TYPE
    bytes.set(denied, 0x900);
    assert.equal(fns.AddAce.handler([WIDE, 2, 0, 0x900, aceSize]), 1);
    assert.equal(bytes[WIDE + 4] | bytes[WIDE + 5] << 8, 2, 'two ACEs');
    assert.equal(bytes[WIDE + 8], 1, 'the denied one first');
    assert.equal(bytes[WIDE + 8 + aceSize], 0, 'the allowed one moved behind it');
    assert.equal(fns.AddAce.handler([WIDE, 2, 0xffffffff, 0x900, aceSize]), 0, 'no room');
    assert.equal(errors.at(-1), 1344);
    assert.equal(fns.AddAce.argBytes, 20);
    assert.equal(fns.InitializeSecurityDescriptor.handler([DESCRIPTOR, 2]), 0);
    assert.equal(errors.at(-1), 1305, 'ERROR_UNKNOWN_REVISION');
});

test('a denied ACE ahead of an allowed one keeps its rights from the account', ()=>{
    // A program closing its own process to others: a DACL denying a SID some
    // rights, then allowing the rest, set on the process with SetSecurityInfo.
    const { bytes, errors, fns, dword } = setup();
    assert.equal(fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 1);
    const token = dword(OUT);
    const DESCRIPTOR = 0x300, ACL_AT = 0x340, MAPPING = 0x400;
    const PRIVILEGES = 0x420, PRIVILEGES_LENGTH = 0x444, GRANTED = 0x448, STATUS = 0x44c;
    bytes.set(ADMINISTRATORS_SID, SID);
    const aclSize = 8 + 2 * (8 + ADMINISTRATORS_SID.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(MAPPING, 1, true);
    view.setUint32(PRIVILEGES_LENGTH, 20, true);

    assert.equal(fns.InitializeSecurityDescriptor.handler([DESCRIPTOR, 1]), 1);
    assert.equal(fns.InitializeAcl.handler([ACL_AT, aclSize, 2]), 1);
    assert.equal(fns.AddAccessDeniedAce.handler([ACL_AT, 2, 0xfa, SID]), 1);
    assert.equal(fns.AddAccessAllowedAce.handler([ACL_AT, 2, 0x100701, SID]), 1);
    assert.equal(bytes[ACL_AT + 8], 1, 'ACCESS_DENIED_ACE_TYPE first');
    assert.equal(fns.SetSecurityDescriptorDacl.handler([DESCRIPTOR, 1, ACL_AT, 0]), 1);
    assert.equal(fns.SetSecurityDescriptorGroup.handler([DESCRIPTOR, SID, 0]), 1);
    assert.equal(fns.SetSecurityDescriptorOwner.handler([DESCRIPTOR, SID, 0]), 1);

    const check = (/** @type {number} */ desired)=>fns.AccessCheck.handler([DESCRIPTOR, token, desired, MAPPING,
        PRIVILEGES, PRIVILEGES_LENGTH, GRANTED, STATUS]);
    assert.equal(check(0x10), 1);
    assert.equal(dword(STATUS), 0, 'a denied right is refused');
    assert.equal(errors.at(-1), 5);
    assert.equal(check(0x1), 1);
    assert.equal(dword(STATUS), 1, 'an allowed one the denial does not name is granted');

    assert.equal(fns.AddAccessDeniedAce.handler([ACL_AT, 2, 1, SID]), 0);
    assert.equal(errors.at(-1), 1344, 'ERROR_ALLOTTED_SPACE_EXCEEDED');
    assert.equal(fns.SetSecurityInfo.handler(), 0);
    assert.equal(fns.SetSecurityInfo.argBytes, 28);
    assert.equal(fns.SetKernelObjectSecurity.handler(), 1);
});

test('GetKernelObjectSecurity sizes, then writes a self-relative descriptor of the parts asked '
    + 'for', ()=>{
    // advapi32's security tests (test_get_security_descriptor): asked with
    // no buffer it fails with ERROR_INSUFFICIENT_BUFFER and the size; asked
    // again with that much it succeeds, owner, group and DACL in place.
    const { fns, bytes, errors, table, dword } = setup();
    const event = 0x40;
    table.set(event, { type: 'event', object: {} });
    const ALL = 0x1 | 0x2 | 0x4;
    assert.equal(fns.GetKernelObjectSecurity.handler([event, ALL, 0, 0, OUT]), 0);
    assert.deepEqual(errors.splice(0), [122], 'ERROR_INSUFFICIENT_BUFFER');
    const size = dword(OUT);
    assert.ok(size > 20);
    assert.equal(fns.GetKernelObjectSecurity.handler([event, ALL, BUFFER, size, OUT]), 1);
    assert.equal(dword(OUT), size);
    const control = bytes[BUFFER + 2] | bytes[BUFFER + 3] << 8;
    assert.equal(control & 0x8004, 0x8004, 'self-relative, with a DACL');
    const owner = BUFFER + dword(BUFFER + 4);
    assert.deepEqual([...bytes.subarray(owner, owner + 16)],
        [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0], 'BUILTIN Administrators');
    assert.notEqual(dword(BUFFER + 8), 0, 'a group');
    assert.equal(dword(BUFFER + 12), 0, 'no SACL');
    const dacl = BUFFER + dword(BUFFER + 16);
    assert.deepEqual([bytes[dacl], bytes[dacl + 4]], [2, 2], 'two ACEs');

    assert.equal(fns.GetKernelObjectSecurity.handler([event, 0x1, BUFFER, size, OUT]), 1);
    assert.deepEqual([dword(BUFFER + 8), dword(BUFFER + 16)], [0, 0],
        'only the owner, when only it is asked for');
    assert.equal(fns.GetKernelObjectSecurity.handler([0x9999, ALL, BUFFER, size, OUT]), 0);
    assert.deepEqual(errors, [6], 'ERROR_INVALID_HANDLE');
});

test('ConvertSidToStringSid writes S-1-authority-subauthorities in a block, narrow or wide', ()=>{
    const { bytes, fns, dword } = setup();
    // S-1-5-32-544: the Administrators group.
    bytes.set([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0], SID);
    assert.equal(fns.ConvertSidToStringSidA.argBytes, 8);
    assert.equal(fns.ConvertSidToStringSidA.handler([SID, OUT]), 1);
    const narrow = dword(OUT);
    assert.equal(String.fromCharCode(...bytes.subarray(narrow, narrow + 12)), 'S-1-5-32-544');
    assert.equal(bytes[narrow + 12], 0);
    assert.equal(fns.ConvertSidToStringSidW.handler([SID, OUT]), 1);
    const wide = dword(OUT);
    assert.deepEqual([...bytes.subarray(wide, wide + 6)], [0x53, 0, 0x2d, 0, 0x31, 0]);
    assert.equal(bytes[wide + 24], 0);
    assert.equal(bytes[wide + 25], 0);
});

test('ConvertSidToStringSid refuses no SID and one that is not a SID', ()=>{
    const { bytes, errors, fns } = setup();
    assert.equal(fns.ConvertSidToStringSidW.handler([0, OUT]), 0);
    bytes[SID] = 9;
    assert.equal(fns.ConvertSidToStringSidW.handler([SID, OUT]), 0);
    assert.deepEqual(errors, [87, 87]);
});
