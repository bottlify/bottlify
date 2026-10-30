/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ADMINISTRATORS_SID, TOKEN_NATIVES, createTokenFunctions, selfRelativeDescriptor,
} from './tokens.js';

const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_TOKEN = 1008;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const TOKEN_QUERY = 8;
const TokenUser = 1;
const TokenGroups = 2;
const CURRENT_THREAD = 0xfffffffe;
const CURRENT_PROCESS = 0xffffffff;

const OUT = 0x100;
const NEEDED = 0x104;
const BUFFER = 0x200;
const SID = 0x600;

function setup(/** @type {{ currentThread?: () => any }} */ extra = {}){
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
        ...extra,
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

test('DuplicateTokenEx makes the token kind asked for; SetTokenInformation moves its session', ()=>{
    // A service starts a program in the user's session: a primary token
    // duplicated from its own, moved to that session, handed to
    // CreateProcessAsUser.
    const { bytes, errors, fns, dword, table } = setup();
    const TokenSessionId = 12;
    const TokenType = 8;
    assert.equal(fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 1);
    const token = dword(OUT);
    assert.equal(fns.DuplicateTokenEx.argBytes, 24);
    assert.equal(fns.DuplicateTokenEx.handler([token, 0x2000000, 0, 2, 1, NEEDED]), 1);
    const primary = dword(NEEDED);
    assert.notEqual(primary, token);
    assert.equal(fns.GetTokenInformation.handler([primary, TokenType, BUFFER, 4, OUT]), 1);
    assert.equal(dword(BUFFER), 1, 'TokenPrimary');
    assert.equal(fns.DuplicateTokenEx.handler([token, 0, 0, 3, 2, NEEDED]), 1);
    assert.equal(table.get(dword(NEEDED))?.object.impersonationLevel, 3, 'SecurityDelegation');
    assert.equal(fns.DuplicateTokenEx.handler([token, 0, 0, 2, 3, NEEDED]), 0, 'no third kind');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);

    const SESSION = 0x300;
    new DataView(bytes.buffer).setUint32(SESSION, 1, true);
    assert.equal(fns.SetTokenInformation.argBytes, 16);
    assert.equal(fns.SetTokenInformation.handler([primary, TokenSessionId, SESSION, 4]), 1);
    assert.equal(fns.GetTokenInformation.handler([primary, TokenSessionId, BUFFER, 4, OUT]), 1);
    assert.equal(dword(BUFFER), 1, 'the session it was moved to');
    assert.equal(fns.GetTokenInformation.handler([token, TokenSessionId, BUFFER, 4, OUT]), 1);
    assert.equal(dword(BUFFER), 0, 'and the token it came from stays in the console\'s');
    assert.equal(fns.SetTokenInformation.handler([primary, TokenSessionId, SESSION, 2]), 0);
    assert.equal(errors.at(-1), 24, 'ERROR_BAD_LENGTH');
    assert.equal(fns.SetTokenInformation.handler([primary, TokenType, SESSION, 4]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'a class only ever read');
    assert.equal(fns.SetTokenInformation.handler([0x1234, TokenSessionId, SESSION, 4]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
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
    { NtOpenProcessToken: 12, NtOpenProcessTokenEx: 16, NtAdjustPrivilegesToken: 24,
        NtSetSecurityObject: 12, NtQuerySecurityObject: 20, NtAccessCheck: 32,
        NtDuplicateToken: 24 });
});

test('NtDuplicateToken clones a token, its level from the SecurityQualityOfService', ()=>{
    const { fns, dword, bytes, table } = setup();
    const natives = fns[TOKEN_NATIVES];
    assert.equal(natives.NtOpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 0);
    const token = dword(OUT);

    // No OBJECT_ATTRIBUTES: an impersonation token at SecurityAnonymous (0).
    assert.equal(natives.NtDuplicateToken.handler([token, 0, 0, 0, 2, OUT]), 0, 'STATUS_SUCCESS');
    const anonymous = dword(OUT);
    assert.notEqual(anonymous, token, 'a handle of its own');
    assert.equal(table.get(anonymous)?.object?.impersonationLevel, 0);

    // A SECURITY_QUALITY_OF_SERVICE at QOS naming SecurityIdentification (2),
    // pointed at by the OBJECT_ATTRIBUTES at ATTR (its field at +20).
    const ATTR = 0x700;
    const QOS = 0x740;
    bytes.fill(0, ATTR, ATTR + 24);
    new DataView(bytes.buffer).setUint32(ATTR + 20, QOS, true);
    new DataView(bytes.buffer).setUint32(QOS + 4, 2, true);
    assert.equal(natives.NtDuplicateToken.handler([token, 0, ATTR, 0, 2, OUT]), 0);
    assert.equal(table.get(dword(OUT))?.object?.impersonationLevel, 2, 'SecurityIdentification');

    // A primary token (type 1) carries no impersonation level at all.
    assert.equal(natives.NtDuplicateToken.handler([token, 0, ATTR, 0, 1, OUT]), 0);
    assert.equal(table.get(dword(OUT))?.object?.impersonationLevel, undefined);

    assert.equal(natives.NtDuplicateToken.handler([0x1234, 0, 0, 0, 2, OUT]), 0xc0000008,
        'STATUS_INVALID_HANDLE');
    assert.equal(natives.NtDuplicateToken.handler([token, 0, 0, 0, 2, 0]), 0xc0000005,
        'nowhere to put it: STATUS_ACCESS_VIOLATION');
});

test('the native security calls set, query and check a kernel object, as NTSTATUS', ()=>{
    // ntdll's NtSetSecurityObject/NtQuerySecurityObject keep and hand back
    // the same descriptor the win32 pair do, and NtAccessCheck answers the
    // walk as a status with an NTSTATUS *AccessStatus, not a BOOL.
    const { bytes, fns, dword, table } = setup();
    const natives = fns[TOKEN_NATIVES];
    const object = {};
    table.set(0x40, { type: 'event', object });
    table.set(0x44, { type: 'event', object });
    // A self-relative descriptor with a present DACL of one ACE allowing
    // BUILTIN\Administrators 0x1 (as the win32 kernel-object test builds).
    const sd = BUFFER;
    bytes.fill(0, sd, sd + 40);
    bytes[sd] = 1;
    bytes.set([0x14, 0x80], sd + 2);
    const dacl = sd + 20;
    new DataView(bytes.buffer).setUint32(sd + 16, dacl - sd, true);
    bytes.set([2, 0, 28, 0, 1, 0, 0, 0, 0, 0, 20, 0, 1, 0, 0, 0,
        1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0], dacl);

    assert.equal(natives.NtSetSecurityObject.handler([0x9999, 0x4, sd]), 0xc0000008,
        'STATUS_INVALID_HANDLE');
    assert.equal(natives.NtSetSecurityObject.handler([0x40, 0x4, 0]), 0xc0000005,
        'no descriptor: STATUS_ACCESS_VIOLATION');
    assert.equal(natives.NtSetSecurityObject.handler([0x40, 0x4, sd]), 0, 'STATUS_SUCCESS');

    // Query it back on the other handle: sized first, then written.
    const OUT_SIZE = 0x600;
    assert.equal(natives.NtQuerySecurityObject.handler([0x44, 0x4, 0x800, 0, OUT_SIZE]),
        0xc0000023, 'STATUS_BUFFER_TOO_SMALL');
    const size = dword(OUT_SIZE);
    assert.ok(size > 20);
    assert.equal(natives.NtQuerySecurityObject.handler([0x44, 0x4, 0x800, size, OUT_SIZE]), 0);
    const control = bytes[0x800 + 2] | bytes[0x800 + 3] << 8;
    assert.equal(control & 0x8004, 0x8004, 'self-relative, with a DACL');
    assert.equal(natives.NtQuerySecurityObject.handler([0x9999, 0x4, 0x800, size, OUT_SIZE]),
        0xc0000008, 'STATUS_INVALID_HANDLE');

    // Check the token the setup grants against that descriptor. The mapping
    // is identity; the granted mask and the NTSTATUS verdict are written out.
    assert.equal(natives.NtOpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 0);
    const token = dword(OUT);
    const MAPPING = 0x900;
    bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x1f], MAPPING);
    const GRANTED = 0xa00;
    const STATUS = 0xa10;
    const PRIV = 0xa20;
    const PRIVLEN = 0xa80;
    new DataView(bytes.buffer).setUint32(PRIVLEN, 0x40, true);
    assert.equal(natives.NtAccessCheck.handler([sd, token, 0x1, MAPPING, PRIV, PRIVLEN,
        GRANTED, STATUS]), 0, 'STATUS_SUCCESS: the check ran');
    assert.equal(dword(STATUS), 0, 'STATUS_SUCCESS: access granted');
    assert.equal(dword(GRANTED), 0x1);
    assert.equal(natives.NtAccessCheck.handler([sd, token, 0x1, MAPPING, PRIV, PRIVLEN,
        GRANTED, 0]), 0xc0000005, 'nowhere for the status: STATUS_ACCESS_VIOLATION');
});

test('CopySid copies a SID that fits and refuses one that does not', ()=>{
    const { bytes, errors, fns } = setup();
    bytes.set(ADMINISTRATORS_SID, SID);
    const length = ADMINISTRATORS_SID.length;
    bytes.fill(0xaa, BUFFER, BUFFER + 0x40);
    assert.equal(fns.CopySid.handler([length, BUFFER, SID]), 1);
    assert.deepEqual([...bytes.subarray(BUFFER, BUFFER + length)], [...ADMINISTRATORS_SID]);
    assert.equal(bytes[BUFFER + length], 0xaa, 'no more than the SID');
    bytes.fill(0xbb, BUFFER, BUFFER + 0x40);
    assert.equal(fns.CopySid.handler([length - 1, BUFFER, SID]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(bytes[BUFFER], 0xbb, 'and nothing was written');
    assert.equal(fns.CopySid.handler([length, 0, SID]), 0);
    assert.equal(fns.CopySid.argBytes, 12);
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

test('PrivilegeCheck finds every privilege held on the token it grants everything on', ()=>{
    // A module that checks a privilege before it reads another process's
    // memory goes on reading through whatever the check left behind when the
    // name does not resolve.
    const { bytes, errors, fns, dword } = setup();
    const TOKEN_OUT = 0x300;
    const SET = 0x400;
    const RESULT = 0x500;
    assert.equal(fns.OpenProcessToken.handler([0xffffffff, 0x8, TOKEN_OUT]), 1);
    const token = dword(TOKEN_OUT);
    // Two privileges, PRIVILEGE_SET_ALL_NECESSARY: SeDebugPrivilege (20), SeShutdownPrivilege (19).
    bytes.set([2, 0, 0, 0, 1, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], SET);

    assert.equal(fns.PrivilegeCheck.handler([token, SET, RESULT]), 1);
    assert.equal(dword(RESULT), 1);
    assert.equal(dword(SET + 16), 0x80000000, 'SE_PRIVILEGE_USED_FOR_ACCESS');
    assert.equal(dword(SET + 28), 0x80000000);
    assert.equal(fns.PrivilegeCheck.handler([0x7777, SET, RESULT]), 0);
    assert.equal(errors.at(-1), 6, 'ERROR_INVALID_HANDLE');
    assert.equal(fns.PrivilegeCheck.argBytes, 12);
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
    assert.equal(fns.SetSecurityInfo.argBytes, 28);
    assert.equal(fns.SetKernelObjectSecurity.handler([0x7777, 4, 0]), 0, 'no such object');
    assert.equal(errors.at(-1), 6);
});

test('a kernel object keeps the DACL and the label set on it, for every handle onto it', ()=>{
    const { bytes, fns, dword, table } = setup();
    const object = {};
    table.set(0x40, { type: 'event', object });
    table.set(0x44, { type: 'event', object });
    // An absolute descriptor at BUFFER: a present DACL of one ACE, and a SACL
    // with a label (0x11) and an allowed ACE, of revision 3.
    const sd = BUFFER;
    bytes.fill(0, sd, sd + 20);
    bytes[sd] = 1;
    bytes.set([0x14, 0], sd + 2);
    const dacl = 0x300;
    const sacl = 0x380;
    bytes.set([2, 0, 28, 0, 1, 0, 0, 0, 0, 0, 20, 0, 1, 0, 0, 0,
        1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], dacl);
    bytes.set([3, 0, 48, 0, 2, 0, 0, 0, 0x11, 0, 20, 0, 1, 0, 0, 0,
        1, 1, 0, 0, 0, 0, 0, 16, 0, 0x10, 0, 0,
        0, 0, 20, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], sacl);
    new DataView(bytes.buffer).setUint32(sd + 12, sacl, true);
    new DataView(bytes.buffer).setUint32(sd + 16, dacl, true);
    assert.equal(fns.SetKernelObjectSecurity.handler([0x40, 0x4 | 0x10, sd]), 1);
    assert.equal(fns.GetKernelObjectSecurity.handler([0x44, 0x10, 0x500, 0x200, NEEDED]), 1);
    const at = 0x500 + dword(0x500 + 12);
    assert.deepEqual([bytes[at], bytes[at + 4]], [3, 1], 'the label alone, in its revision');
    assert.equal(bytes[at + 8], 0x11);
    assert.equal(fns.GetKernelObjectSecurity.handler([0x44, 0x4, 0x500, 0x200, NEEDED]), 1);
    assert.equal(bytes[0x500 + dword(0x500 + 16) + 4], 1, 'the DACL set: one ACE');
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

test('ConvertStringSidToSid lays out the SID its text names, and the text ConvertSidToStringSid'
    + ' writes back is the same', ()=>{
    const { bytes, errors, fns, dword } = setup();
    assert.equal(fns.ConvertStringSidToSidA.argBytes, 8);
    const text = putNarrow(bytes, 0x300, 'S-1-5-21-1-2-3-1001');
    assert.equal(fns.ConvertStringSidToSidA.handler([text, OUT]), 1);
    assert.equal(fns.ConvertSidToStringSidA.handler([dword(OUT), OUT]), 1);
    const back = dword(OUT);
    assert.equal(String.fromCharCode(...bytes.subarray(back, back + 19)), 'S-1-5-21-1-2-3-1001');
    assert.equal(fns.ConvertStringSidToSidW.handler([putWide(bytes, 0x300, 'ba'), OUT]), 1);
    assert.deepEqual([...bytes.subarray(dword(OUT), dword(OUT) + 16)],
        [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0], 'BA: the Administrators group');
    const narrow = fns.ConvertStringSidToSidA.handler;
    assert.equal(narrow([putNarrow(bytes, 0x300, 'S-1-0x10000000000-7'), OUT]), 1);
    assert.deepEqual([...bytes.subarray(dword(OUT), dword(OUT) + 8)], [1, 1, 1, 0, 0, 0, 0, 0],
        'an authority past 32 bits, big-endian');
    for (const bad of ['', 'S-1', 'S-2-5', 'S-1-5-x', 'S-1-5-4294967296', 'XX'])
    {
        assert.equal(narrow([putNarrow(bytes, 0x300, bad), OUT]), 0, bad);
    }
    assert.equal(fns.ConvertStringSidToSidA.handler([0, OUT]), 0);
    assert.deepEqual(errors.filter(code=>code !== 0), [1337, 1337, 1337, 1337, 1337, 1337, 87]);
});

/** @param {Uint8Array} bytes @param {number} at @param {string} text */
const putNarrow = (bytes, at, text)=>{
    bytes.set([...text, '\0'].map(unit=>unit.charCodeAt(0)), at);
    return at;
};
/** @param {Uint8Array} bytes @param {number} at @param {string} text */
const putWide = (bytes, at, text)=>{
    [...text, '\0'].forEach((unit, index)=>{
        bytes[at + index * 2] = unit.charCodeAt(0) & 0xff;
        bytes[at + index * 2 + 1] = unit.charCodeAt(0) >>> 8;
    });
    return at;
};
/** @param {Uint8Array} bytes @param {number} at @param {number} units */
const wideAt = (bytes, at, units)=>String.fromCharCode(
    ...new Uint16Array(bytes.slice(at, at + units * 2).buffer));

/** S-1-<authority>-<subs>, laid out. @param {number} authority @param {number[]} subs */
const sidOf = (authority, subs)=>{
    const sid = new Uint8Array(8 + 4 * subs.length);
    sid[0] = 1;
    sid[1] = subs.length;
    sid[7] = authority;
    subs.forEach((sub, at)=>new DataView(sid.buffer).setUint32(8 + at * 4, sub, true));
    return sid;
};
const EVERYONE = sidOf(1, [0]);
const USERS = sidOf(5, [32, 545]);
const SYSTEM = sidOf(5, [18]);

test('LookupPrivilegeValueW finds what the A form finds, whatever the case', ()=>{
    // advapi32's security tests (test_LookupPrivilegeValue): another machine
    // is RPC_S_SERVER_UNAVAILABLE, a NULL name and a bogus one are
    // ERROR_NO_SUCH_PRIVILEGE, and the case of the name does not matter.
    const { bytes, errors, fns, dword } = setup();
    const NAME = 0x300;
    const MACHINE = 0x380;
    const LUID = 0x3f0;
    assert.equal(fns.LookupPrivilegeValueW.argBytes, 12);

    putWide(bytes, NAME, 'SeShutdownPrivilege');
    assert.equal(fns.LookupPrivilegeValueW.handler([0, NAME, LUID]), 1);
    assert.deepEqual([dword(LUID), dword(LUID + 4)], [19, 0]);
    putWide(bytes, NAME, 'sErESTOREpRIVILEGE');
    assert.equal(fns.LookupPrivilegeValueW.handler([0, NAME, LUID]), 1);
    assert.equal(dword(LUID), 18);
    putNarrow(bytes, NAME, 'sEcREATEtOKENpRIVILEGE');
    assert.equal(fns.LookupPrivilegeValueA.handler([0, NAME, LUID]), 1, 'and the A form too');
    assert.equal(dword(LUID), 2);

    errors.length = 0;
    assert.equal(fns.LookupPrivilegeValueW.handler([0, 0, LUID]), 0);
    assert.equal(fns.LookupPrivilegeValueA.handler([0, 0, LUID]), 0);
    putWide(bytes, NAME, 'SeBogusPrivilege');
    assert.equal(fns.LookupPrivilegeValueW.handler([0, NAME, LUID]), 0);
    assert.deepEqual(errors, [1313, 1313, 1313], 'ERROR_NO_SUCH_PRIVILEGE');

    putWide(bytes, NAME, 'SeShutdownPrivilege');
    putWide(bytes, MACHINE, 'b0gu5.Nam3');
    assert.equal(fns.LookupPrivilegeValueW.handler([MACHINE, NAME, LUID]), 0);
    assert.equal(errors.at(-1), 1722, 'RPC_S_SERVER_UNAVAILABLE');
    putWide(bytes, MACHINE, '\\\\bottlify');
    assert.equal(fns.LookupPrivilegeValueW.handler([MACHINE, NAME, LUID]), 1,
        'this machine by its own name');
    putWide(bytes, MACHINE, '');
    assert.equal(fns.LookupPrivilegeValueW.handler([MACHINE, NAME, LUID]), 1, 'or by none');
});

test('GetAce points into the ACL at the ACE asked for, and refuses one past the last', ()=>{
    const { bytes, errors, fns, dword } = setup();
    const ACL_AT = 0x400;
    assert.equal(fns.GetAce.argBytes, 12);
    bytes.set(USERS, SID);
    assert.equal(fns.InitializeAcl.handler([ACL_AT, 0x80, 2]), 1);
    assert.equal(fns.AddAccessAllowedAce.handler([ACL_AT, 2, 0x20019, SID]), 1);
    bytes.set(EVERYONE, SID);
    assert.equal(fns.AddAccessDeniedAce.handler([ACL_AT, 2, 0x10000, SID]), 1);

    assert.equal(fns.GetAce.handler([ACL_AT, 0, OUT]), 1);
    assert.equal(dword(OUT), ACL_AT + 8, 'the first ACE follows the header');
    assert.equal(fns.GetAce.handler([ACL_AT, 1, OUT]), 1);
    assert.equal(dword(OUT), ACL_AT + 8 + 8 + USERS.length, 'the second the first');
    assert.deepEqual([bytes[dword(OUT)], dword(dword(OUT) + 4)], [1, 0x10000],
        'a pointer into the ACL itself: the denied ACE, its mask');

    assert.equal(fns.GetAce.handler([ACL_AT, 2, OUT]), 0, 'past the last');
    bytes[ACL_AT] = 9;
    assert.equal(fns.GetAce.handler([ACL_AT, 0, OUT]), 0, 'not an ACL revision');
    assert.equal(fns.GetAce.handler([0, 0, OUT]), 0, 'no ACL');
    assert.deepEqual(errors, [87, 87, 87], 'ERROR_INVALID_PARAMETER');
});

test('LookupAccountSid names the well-known SIDs as XP does, and sizes as Windows sizes', ()=>{
    // advapi32's security tests (test_LookupAccountSid): what fits is
    // written, its size then its length; what does not fit fails with
    // ERROR_INSUFFICIENT_BUFFER and its size with the terminator.
    const { bytes, errors, fns, dword } = setup();
    const NAME = 0x300;
    const DOMAIN = 0x380;
    const NAME_SIZE = 0x3e0;
    const DOMAIN_SIZE = 0x3e4;
    const USE = 0x3e8;
    const MACHINE = 0x3f0;
    const view = new DataView(bytes.buffer);
    /** @param {number} name @param {number} domain */
    const room = (name, domain)=>{
        view.setUint32(NAME_SIZE, name, true);
        view.setUint32(DOMAIN_SIZE, domain, true);
        view.setUint32(USE, 0, true);
    };
    /** @param {Uint8Array} sid @param {boolean} [wide] */
    const lookUp = (sid, wide = false)=>{
        bytes.set(sid, SID);
        return (wide ? fns.LookupAccountSidW : fns.LookupAccountSidA).handler(
            [0, SID, NAME, NAME_SIZE, DOMAIN, DOMAIN_SIZE, USE]);
    };
    /** @param {number} at */
    const narrow = at=>String.fromCharCode(...bytes.subarray(at, bytes.indexOf(0, at)));
    assert.equal(fns.LookupAccountSidA.argBytes, 28);
    assert.equal(fns.LookupAccountSidW.argBytes, 28);

    for (const [sid, name, domain, use] of /** @type {[Uint8Array, string, string, number][]} */ ([
        [USERS, 'Users', 'BUILTIN', 4],
        [sidOf(5, [32, 544]), 'Administrators', 'BUILTIN', 4],
        [EVERYONE, 'Everyone', '', 5],
        [SYSTEM, 'SYSTEM', 'NT AUTHORITY', 5],
        [sidOf(5, [11]), 'Authenticated Users', 'NT AUTHORITY', 5],
        [sidOf(3, [0]), 'CREATOR OWNER', '', 5],
        [sidOf(5, [32]), 'BUILTIN', 'BUILTIN', 3],
    ]))
    {
        room(260, 260);
        assert.equal(lookUp(sid), 1, name);
        assert.deepEqual([narrow(NAME), narrow(DOMAIN), dword(USE)], [name, domain, use]);
        assert.deepEqual([dword(NAME_SIZE), dword(DOMAIN_SIZE)], [name.length, domain.length],
            'the lengths, without terminators');
        room(260, 260);
        assert.equal(lookUp(sid, true), 1);
        assert.equal(wideAt(bytes, NAME, name.length + 1), `${name}\0`);
        assert.equal(wideAt(bytes, DOMAIN, domain.length + 1), `${domain}\0`);
    }

    // The account's own SID, as its token gives it, is the user GetUserName names.
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    fns.GetTokenInformation.handler([dword(OUT), TokenUser, BUFFER, 0x100, NEEDED]);
    room(260, 260);
    assert.equal(fns.LookupAccountSidA.handler([0, dword(BUFFER), NAME, NAME_SIZE, DOMAIN,
        DOMAIN_SIZE, USE]), 1);
    assert.deepEqual([narrow(NAME), narrow(DOMAIN), dword(USE)], ['User', 'BOTTLIFY', 1]);

    errors.length = 0;
    room(1, 260);
    assert.equal(lookUp(USERS), 0, 'a name buffer too small');
    assert.deepEqual([dword(NAME_SIZE), dword(DOMAIN_SIZE), dword(USE)],
        ['Users'.length + 1, 'BUILTIN'.length + 1, 0], 'both sizes, terminators counted');
    room(260, 0);
    assert.equal(lookUp(USERS, true), 0, 'a domain buffer of nothing');
    assert.equal(dword(DOMAIN_SIZE), 'BUILTIN'.length + 1);
    room(0, 0);
    assert.equal(fns.LookupAccountSidW.handler([0, SID, 0, NAME_SIZE, 0, DOMAIN_SIZE, USE]), 0,
        'the two-call way of learning the sizes');
    assert.notEqual(dword(NAME_SIZE), 0);
    assert.equal(dword(USE), 0, 'the use is not written for a failure');
    assert.deepEqual(errors, [122, 122, 122], 'ERROR_INSUFFICIENT_BUFFER');

    room(260, 260);
    bytes.fill(0xee, NAME, NAME + 8);
    assert.equal(fns.LookupAccountSidA.handler([0, SID, 0, NAME_SIZE, DOMAIN, DOMAIN_SIZE, USE]),
        1, 'no name buffer: only the domain is written');
    assert.equal(narrow(DOMAIN), 'BUILTIN');
    assert.equal(bytes[NAME], 0xee);

    room(260, 260);
    assert.equal(lookUp(sidOf(5, [21, 0x1a2b3c4d, 0x2b3c4d5e, 0x3c4d5e6f, 1234])), 0);
    assert.equal(errors.at(-1), 1332, 'ERROR_NONE_MAPPED: no such account here');
    putNarrow(bytes, MACHINE, 'deepthought');
    assert.equal(fns.LookupAccountSidA.handler([MACHINE, SID, NAME, NAME_SIZE, DOMAIN,
        DOMAIN_SIZE, USE]), 0);
    assert.equal(errors.at(-1), 1722, 'RPC_S_SERVER_UNAVAILABLE');
    bytes[SID] = 2;
    assert.equal(lookUp(bytes.slice(SID, SID + 12)), 0);
    assert.equal(errors.at(-1), 1337, 'ERROR_INVALID_SID');
});

/**
 * Lays out EXPLICIT_ACCESS entries at an address, 32 bytes each.
 *
 * @param {Uint8Array} bytes @param {number} at
 * @param {{ rights: number, mode: number, inheritance?: number, form?: number,
 *           operation?: number, name: number }[]} entries
 */
const putEntries = (bytes, at, entries)=>{
    const view = new DataView(bytes.buffer);
    entries.forEach((entry, index)=>{
        const base = at + index * 32;
        view.setUint32(base, entry.rights, true);
        view.setUint32(base + 4, entry.mode, true);
        view.setUint32(base + 8, entry.inheritance ?? 0, true);
        view.setUint32(base + 12, entry.operation === undefined ? 0 : 0xdeadbeef, true);
        view.setUint32(base + 16, entry.operation ?? 0, true);
        view.setUint32(base + 20, entry.form ?? 0, true);
        view.setUint32(base + 24, 0, true);
        view.setUint32(base + 28, entry.name, true);
    });
    return at;
};

/**
 * The ACEs of an ACL in guest memory: type, flags, mask, and the SID as bytes.
 * One SetEntriesInAcl made is exactly as long as its ACEs; one InitializeAcl
 * made has the room it was given.
 *
 * @param {Uint8Array} bytes @param {number} acl @param {boolean} [tight]
 */
const acesAt = (bytes, acl, tight = true)=>{
    const view = new DataView(bytes.buffer);
    const aces = [];
    let at = acl + 8;
    for (let index = 0; index < view.getUint16(acl + 4, true); index++)
    {
        const size = view.getUint16(at + 2, true);
        aces.push({ type: bytes[at], flags: bytes[at + 1], mask: view.getUint32(at + 4, true),
            sid: [...bytes.subarray(at + 8, at + size)] });
        at += size;
    }
    if (tight)
    {
        assert.equal(at - acl, view.getUint16(acl + 2, true), 'the ACL is as long as its ACEs');
    }
    return aces;
};

test('SetEntriesInAcl merges grants, sets, denies and revokes into a new ACL of its own', ()=>{
    // advapi32's security tests (test_SetEntriesInAclW/A): no entries and no
    // ACL is a NULL ACL; a trustee by SID ignores the multiple-trustee
    // fields; by name, "Everyone" and "CURRENT_USER" are found; a bad form
    // or an impersonating multiple trustee is ERROR_INVALID_PARAMETER and
    // leaves NULL behind.
    const { bytes, errors, fns, dword } = setup();
    const OLD = 0x300;
    const ENTRIES = 0x400;
    const TRUSTEE = 0x480;
    const NAME = 0x4c0;
    const NEW = 0x3fc;
    const KEY_READ = 0x20019;
    const KEY_WRITE = 0x20006;
    const view = new DataView(bytes.buffer);
    assert.equal(fns.SetEntriesInAclW.argBytes, 16);
    assert.equal(fns.SetEntriesInAclA.argBytes, 16);

    view.setUint32(NEW, 0xdeadbeef, true);
    assert.equal(fns.SetEntriesInAclW.handler([0, 0, 0, NEW]), 0);
    assert.equal(dword(NEW), 0, 'nothing in, nothing out');

    bytes.set(USERS, SID);
    fns.InitializeAcl.handler([OLD, 0x80, 2]);
    fns.AddAccessAllowedAce.handler([OLD, 2, KEY_READ, SID]);
    bytes.set(EVERYONE, TRUSTEE);

    putEntries(bytes, ENTRIES, [{ rights: KEY_WRITE, mode: 1, name: TRUSTEE,
        operation: 0xdeadbeef }]);
    assert.equal(fns.SetEntriesInAclW.handler([1, ENTRIES, OLD, NEW]), 0);
    const merged = dword(NEW);
    assert.ok(merged >= 0x800, 'a block of its own');
    assert.deepEqual(acesAt(bytes, merged), [
        { type: 0, flags: 0, mask: KEY_READ, sid: [...USERS] },
        { type: 0, flags: 0, mask: KEY_WRITE, sid: [...EVERYONE] },
    ], 'the old ACE kept, the grant after it');
    assert.equal(acesAt(bytes, OLD, false).length, 1, 'the old ACL is not changed');

    putEntries(bytes, ENTRIES, [{ rights: KEY_WRITE, mode: 1, name: SID }]);
    fns.SetEntriesInAclW.handler([1, ENTRIES, OLD, NEW]);
    assert.deepEqual(acesAt(bytes, dword(NEW)), [
        { type: 0, flags: 0, mask: KEY_READ | KEY_WRITE, sid: [...USERS] },
    ], 'a grant to a trustee already allowed adds to its ACE');

    putEntries(bytes, ENTRIES, [{ rights: 0x10000, mode: 2, name: SID, inheritance: 3 }]);
    fns.SetEntriesInAclW.handler([1, ENTRIES, OLD, NEW]);
    assert.deepEqual(acesAt(bytes, dword(NEW)), [
        { type: 0, flags: 3, mask: 0x10000, sid: [...USERS] },
    ], 'a set replaces what the trustee had, inherited by containers and objects');

    putEntries(bytes, ENTRIES, [{ rights: 0, mode: 4, name: SID }]);
    fns.SetEntriesInAclW.handler([1, ENTRIES, OLD, NEW]);
    assert.deepEqual(acesAt(bytes, dword(NEW)), [], 'a revoke takes what it was allowed');

    putEntries(bytes, ENTRIES, [
        { rights: KEY_WRITE, mode: 1, name: putWide(bytes, NAME, 'everyone'), form: 1 },
        { rights: 0x10000, mode: 3, name: TRUSTEE },
    ]);
    fns.SetEntriesInAclW.handler([2, ENTRIES, OLD, NEW]);
    assert.deepEqual(acesAt(bytes, dword(NEW)), [
        { type: 1, flags: 0, mask: 0x10000, sid: [...EVERYONE] },
        { type: 0, flags: 0, mask: KEY_READ, sid: [...USERS] },
        { type: 0, flags: 0, mask: KEY_WRITE, sid: [...EVERYONE] },
    ], 'a trustee by name; the denied ACE ahead of every allowed one');

    putEntries(bytes, ENTRIES, [{ rights: KEY_READ, mode: 2, form: 1,
        name: putNarrow(bytes, NAME, 'CURRENT_USER') }]);
    assert.equal(fns.SetEntriesInAclA.handler([1, ENTRIES, 0, NEW]), 0);
    const user = acesAt(bytes, dword(NEW));
    assert.equal(user.length, 1);
    assert.deepEqual(user[0].sid.slice(-4), [0xe8, 0x03, 0, 0], 'the account itself, RID 1000');
    putEntries(bytes, ENTRIES, [{ rights: KEY_READ, mode: 1, form: 1,
        name: putNarrow(bytes, NAME, 'BUILTIN\\Administrators') }]);
    fns.SetEntriesInAclA.handler([1, ENTRIES, 0, NEW]);
    assert.deepEqual(acesAt(bytes, dword(NEW))[0].sid, [...ADMINISTRATORS_SID]);

    for (const [entry, code] of /** @type {[any, number][]} */ ([
        [{ rights: KEY_READ, mode: 1, form: 2, name: TRUSTEE }, 87],
        [{ rights: KEY_READ, mode: 1, form: 1, name: putWide(bytes, NAME, 'Everyone'),
            operation: 1 }, 87],
        [{ rights: KEY_READ, mode: 9, name: TRUSTEE }, 87],
        [{ rights: KEY_READ, mode: 1, form: 1, name: putWide(bytes, NAME, 'Nobody At All') },
            1332],
    ]))
    {
        putEntries(bytes, ENTRIES, [entry]);
        view.setUint32(NEW, 0xdeadbeef, true);
        assert.equal(fns.SetEntriesInAclW.handler([1, ENTRIES, OLD, NEW]), code);
        assert.equal(dword(NEW), 0, 'a failure leaves NULL');
    }
    assert.equal(fns.SetEntriesInAclW.handler([1, ENTRIES, OLD, 0]), 87, 'nowhere to put it');
    assert.deepEqual(errors, [], 'the answer is the return value, not the last error');
});

test('SetEntriesInAcl keeps inherited ACEs last, and audits for a SACL', ()=>{
    const { bytes, fns, dword } = setup();
    const OLD = 0x300;
    const ENTRIES = 0x400;
    const NEW = 0x3fc;
    const ACE = 0x4c0;
    // An ACE the ACL inherited, put in by hand: INHERITED_ACE, SYSTEM all.
    bytes.set([0, 0x10, 8 + SYSTEM.length, 0, 0xff, 0x01, 0x1f, 0x00, ...SYSTEM], ACE);
    fns.InitializeAcl.handler([OLD, 0x80, 2]);
    fns.AddAce.handler([OLD, 2, 0, ACE, 8 + SYSTEM.length]);
    bytes.set(USERS, SID);
    putEntries(bytes, ENTRIES, [
        { rights: 0x20019, mode: 1, name: SID },
        { rights: 0x10000, mode: 5, name: SID },
        { rights: 0x10000, mode: 6, name: SID },
    ]);
    assert.equal(fns.SetEntriesInAclW.handler([3, ENTRIES, OLD, NEW]), 0);
    assert.deepEqual(acesAt(bytes, dword(NEW)).map(ace=>[ace.type, ace.flags, ace.mask]), [
        [0, 0, 0x20019],
        [2, 0x40, 0x10000],
        [2, 0x80, 0x10000],
        [0, 0x10, 0x1f01ff],
    ], 'the explicit ones, then the inherited one as it was');

    putEntries(bytes, ENTRIES, [{ rights: 0, mode: 4, name: SID }]);
    fns.SetEntriesInAclW.handler([1, ENTRIES, dword(NEW), NEW]);
    assert.deepEqual(acesAt(bytes, dword(NEW)).map(ace=>[ace.type, ace.flags]), [[0, 0x10]],
        'a revoke takes the allowed and the audited, never the inherited');
});

test('AccessCheck reads an audit ACE as nothing to do with who is let in', ()=>{
    const { bytes, fns, dword } = setup();
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    const token = dword(OUT);
    const DESCRIPTOR = 0x300;
    const ACL_AT = 0x340;
    const MAPPING = 0x400;
    const LENGTH = 0x440;
    const GRANTED = 0x444;
    const STATUS = 0x448;
    const ACE = 0x4c0;
    // SYSTEM_AUDIT for Everyone, all rights, ahead of an allowed ACE.
    bytes.set([2, 0x40, 8 + EVERYONE.length, 0, 0xff, 0xff, 0x1f, 0, ...EVERYONE], ACE);
    fns.InitializeSecurityDescriptor.handler([DESCRIPTOR, 1]);
    fns.InitializeAcl.handler([ACL_AT, 0x40, 2]);
    fns.AddAce.handler([ACL_AT, 2, 0, ACE, 8 + EVERYONE.length]);
    bytes.set(EVERYONE, SID);
    fns.AddAccessAllowedAce.handler([ACL_AT, 2, 1, SID]);
    fns.SetSecurityDescriptorDacl.handler([DESCRIPTOR, 1, ACL_AT, 0]);
    new DataView(bytes.buffer).setUint32(MAPPING, 1, true);
    new DataView(bytes.buffer).setUint32(LENGTH, 20, true);
    assert.equal(fns.AccessCheck.handler([DESCRIPTOR, token, 1, MAPPING, 0, LENGTH, GRANTED,
        STATUS]), 1);
    assert.deepEqual([dword(STATUS), dword(GRANTED)], [1, 1], 'allowed, the audit not a denial');
});

test('the SID pointers point into the SID: the authority, a sub-authority, the count', ()=>{
    const { bytes, errors, fns } = setup();
    // S-1-5-32-544, laid out: revision, count, authority (big-endian), then the subs.
    bytes.set([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0], SID);
    assert.equal(fns.GetSidIdentifierAuthority.handler([SID]), SID + 2);
    assert.equal(bytes[fns.GetSidIdentifierAuthority.handler([SID]) + 5], 5, 'NT authority');
    assert.equal(fns.GetSidSubAuthorityCount.handler([SID]), SID + 1);
    assert.equal(bytes[fns.GetSidSubAuthorityCount.handler([SID])], 2);
    assert.equal(fns.GetSidSubAuthority.handler([SID, 0]), SID + 8);
    assert.equal(fns.GetSidSubAuthority.handler([SID, 1]), SID + 12);
    assert.deepEqual([...new Set(errors)], [0], 'success is said, as Windows says it');
    assert.equal(fns.GetSidSubAuthority.argBytes, 8);
    assert.equal(fns.GetSidIdentifierAuthority.argBytes, 4);
    assert.equal(fns.GetSidSubAuthorityCount.argBytes, 4);
});

test('SetThreadToken gives a thread the impersonation token OpenThreadToken then opens', ()=>{
    const { bytes, errors, fns, dword, table } = setup();
    assert.equal(fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]), 1);
    const primary = dword(OUT);
    assert.equal(fns.SetThreadToken.handler([0, primary]), 0, 'a primary token is not one');
    assert.deepEqual(errors, [1349], 'ERROR_BAD_TOKEN_TYPE');
    assert.equal(fns.SetThreadToken.handler([0, 0x7777]), 0);
    assert.deepEqual(errors, [1349, ERROR_INVALID_HANDLE]);

    assert.equal(fns.DuplicateToken.handler([primary, 2, NEEDED]), 1);
    const impersonation = dword(NEEDED);
    assert.equal(fns.SetThreadToken.handler([0, impersonation]), 1);
    assert.equal(fns.OpenThreadToken.handler([CURRENT_THREAD, TOKEN_QUERY, 0, OUT]), 1);
    const opened = dword(OUT);
    assert.notEqual(opened, impersonation, 'a handle of its own');
    assert.equal(table.get(opened)?.object, table.get(impersonation)?.object, 'onto that token');

    // A thread named through a pointer to its handle is the same thread.
    new DataView(bytes.buffer).setUint32(BUFFER, CURRENT_THREAD, true);
    assert.equal(fns.SetThreadToken.handler([BUFFER, 0]), 1, 'NULL reverts');
    assert.equal(fns.OpenThreadToken.handler([CURRENT_THREAD, TOKEN_QUERY, 0, OUT]), 0);
    assert.equal(errors.at(-1), ERROR_NO_TOKEN);
});

test('ImpersonateSelf gives the calling thread a token, RevertToSelf takes it away', ()=>{
    let thread = { name: 'main' };
    const { errors, fns, table, dword } = setup({ currentThread: ()=>thread });
    assert.equal(fns.ImpersonateSelf.handler([2]), 1);
    assert.equal(fns.OpenThreadToken.handler([CURRENT_THREAD, TOKEN_QUERY, 0, OUT]), 1);
    assert.equal(table.get(dword(OUT))?.object.impersonationLevel, 2);

    const main = thread;
    thread = { name: 'worker' };
    assert.equal(fns.OpenThreadToken.handler([CURRENT_THREAD, TOKEN_QUERY, 0, OUT]), 0,
        'another thread impersonates nobody');
    assert.equal(errors.at(-1), ERROR_NO_TOKEN);
    assert.equal(fns.RevertToSelf.handler(), 1, 'reverting without impersonating is nothing');

    thread = main;
    assert.equal(fns.RevertToSelf.handler(), 1);
    assert.equal(fns.OpenThreadToken.handler([CURRENT_THREAD, TOKEN_QUERY, 0, OUT]), 0);
    assert.equal(fns.ImpersonateSelf.argBytes, 4);
    assert.equal(fns.RevertToSelf.argBytes, 0);
    assert.equal(fns.SetThreadToken.argBytes, 8);
});

test('a descriptor is read back through its getters, absolute or self-relative', ()=>{
    // An installer copies a folder's security: it reads the descriptor
    // GetFileSecurity filled in, which is self-relative, part by part.
    const { bytes, errors, fns, dword } = setup();
    const DESCRIPTOR = 0x300, ACL_AT = 0x340, OUTS = 0x500, RELATIVE = 0x700;
    bytes.set(ADMINISTRATORS_SID, SID);
    const aclSize = 8 + 8 + ADMINISTRATORS_SID.length;
    assert.equal(fns.InitializeSecurityDescriptor.handler([DESCRIPTOR, 1]), 1);
    assert.equal(fns.InitializeAcl.handler([ACL_AT, aclSize, 2]), 1);
    assert.equal(fns.AddAccessAllowedAce.handler([ACL_AT, 2, 1, SID]), 1);
    assert.equal(fns.SetSecurityDescriptorDacl.handler([DESCRIPTOR, 1, ACL_AT, 1]), 1);
    assert.equal(fns.SetSecurityDescriptorOwner.handler([DESCRIPTOR, SID, 0]), 1);

    assert.equal(fns.GetSecurityDescriptorControl.handler([DESCRIPTOR, OUTS, OUTS + 4]), 1);
    assert.equal(bytes[OUTS] | bytes[OUTS + 1] << 8, 0x0004 | 0x0008, 'DACL present, defaulted');
    assert.equal(dword(OUTS + 4), 1, 'revision');
    assert.equal(fns.GetSecurityDescriptorOwner.handler([DESCRIPTOR, OUTS, OUTS + 4]), 1);
    assert.equal(dword(OUTS), SID);
    assert.equal(dword(OUTS + 4), 0);
    assert.equal(fns.GetSecurityDescriptorGroup.handler([DESCRIPTOR, OUTS, OUTS + 4]), 1);
    assert.equal(dword(OUTS), 0, 'no group');
    assert.equal(fns.GetSecurityDescriptorDacl.handler([DESCRIPTOR, OUTS, OUTS + 4, OUTS + 8]),
        1);
    assert.deepEqual([dword(OUTS), dword(OUTS + 4), dword(OUTS + 8)], [1, ACL_AT, 1]);
    new DataView(bytes.buffer).setUint32(OUTS + 4, 0xabcd, true);
    assert.equal(fns.GetSecurityDescriptorSacl.handler([DESCRIPTOR, OUTS, OUTS + 4, OUTS + 8]),
        1);
    assert.equal(dword(OUTS), 0, 'no SACL');
    assert.equal(dword(OUTS + 4), 0xabcd, 'and the list left as it was');
    assert.equal(fns.GetSecurityDescriptorLength.handler([DESCRIPTOR]),
        20 + ADMINISTRATORS_SID.length + aclSize);
    assert.equal(fns.IsValidAcl.handler([ACL_AT]), 1);
    assert.equal(fns.IsValidAcl.handler([SID]), 0, 'a SID is no ACL');

    // The same parts laid out self-relative: offsets, not pointers.
    const { bytes: relative } = selfRelativeDescriptor({ owner: ADMINISTRATORS_SID,
        dacl: bytes.slice(ACL_AT, ACL_AT + aclSize) });
    bytes.set(relative, RELATIVE);
    assert.equal(fns.GetSecurityDescriptorOwner.handler([RELATIVE, OUTS, OUTS + 4]), 1);
    assert.deepEqual([...bytes.subarray(dword(OUTS), dword(OUTS) + ADMINISTRATORS_SID.length)],
        [...ADMINISTRATORS_SID]);
    assert.equal(fns.GetSecurityDescriptorDacl.handler([RELATIVE, OUTS, OUTS + 4, OUTS + 8]), 1);
    assert.equal(fns.IsValidAcl.handler([dword(OUTS + 4)]), 1, 'the pointer is into the block');
    assert.equal(fns.GetSecurityDescriptorLength.handler([RELATIVE]), relative.length);

    assert.equal(fns.GetSecurityDescriptorOwner.handler([0, OUTS, OUTS + 4]), 0);
    assert.equal(errors.at(-1), 1338, 'ERROR_INVALID_SECURITY_DESCR');
});

test('MapGenericMask replaces each generic right with the mapping\'s specific ones', ()=>{
    const { bytes, fns, dword } = setup();
    const view = new DataView(bytes.buffer);
    [0x1, 0x2, 0x4, 0x1f].forEach((rights, at)=>view.setUint32(0x110 + at * 4, rights, true));
    view.setUint32(0x100, 0xa0000100, true);   // GENERIC_READ | GENERIC_EXECUTE | a specific right
    assert.equal(fns.MapGenericMask.handler([0x100, 0x110]), 0);
    assert.equal(dword(0x100), 0x105, 'the generic bits gone, read and execute mapped in');
});

test('ConvertStringSecurityDescriptorToSecurityDescriptor lays out the descriptor its SDDL names',
    ()=>{
        const { bytes, errors, fns, dword } = setup();
        const convert = fns.ConvertStringSecurityDescriptorToSecurityDescriptorW.handler;
        assert.equal(convert([putWide(bytes, 0x300, 'D:(A;;GA;;;WD)'), 1, OUT, NEEDED]), 1);
        const at = dword(OUT);
        assert.equal(dword(NEEDED), 48);
        // Self-relative, a DACL present, one ACE granting Everyone GENERIC_ALL.
        assert.deepEqual([...bytes.subarray(at, at + 48)], [
            1, 0, 4, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x14, 0, 0, 0,
            2, 0, 0x1c, 0, 1, 0, 0, 0,
            0, 0, 0x14, 0, 0, 0, 0, 0x10, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
        ]);
        assert.equal(fns.ConvertStringSecurityDescriptorToSecurityDescriptorA
            .handler([putNarrow(bytes, 0x300, 'O:BAG:SYD:P(A;OICI;FA;;;BA)'), 1, OUT, 0]), 1);
        const owned = dword(OUT);
        assert.equal(bytes[owned + 3], 0x90, 'protected, self-relative');
        assert.notEqual(dword(owned + 4), 0, 'an owner');
        assert.notEqual(dword(owned + 8), 0, 'a group');
        assert.equal(convert([putWide(bytes, 0x300, 'D:NO_ACCESS_CONTROL'), 1, OUT, 0]), 1);
        assert.equal(dword(dword(OUT) + 16), 0, 'the null DACL: present, at no offset');
        assert.equal(convert([putWide(bytes, 0x300, 'D:(Z;;GA;;;WD)'), 1, OUT, 0]), 0);
        assert.equal(convert([putWide(bytes, 0x300, 'D:(A;;GA;;;WD)'), 2, OUT, 0]), 0);
        assert.deepEqual(errors.filter(code=>code !== 0), [87, 1305]);
    });

test('an ACL takes the highest revision an ACE was added with; one past the last stops it', ()=>{
    const { bytes, errors, fns } = setup();
    const acl = 0x300;
    bytes.set([1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], SID); // S-1-1-0
    assert.equal(fns.InitializeAcl.handler([acl, 256, 3]), 1, 'revision 3 is one');
    assert.equal(fns.InitializeAcl.handler([acl, 256, 2]), 1);
    assert.equal(fns.AddAccessAllowedAceEx.handler([acl, 4, 0x4, 0x10, SID]), 1);
    assert.equal(bytes[acl], 4);
    assert.equal(bytes[acl + 8 + 1], 0x4, 'the ACE keeps its flags');
    const ace = bytes.slice(acl + 8, acl + 8 + 20);
    bytes.set(ace, 0x500);
    assert.equal(fns.AddAce.handler([acl, 5, 0xffffffff, 0x500, 20]), 1);
    assert.equal(bytes[acl], 5, 'written as given');
    assert.equal(fns.AddAce.handler([acl, 2, 0xffffffff, 0x500, 20]), 0);
    assert.equal(errors.at(-1), 87);
});

test('AddMandatoryAce takes only the three policies, as a label ACE', ()=>{
    const { bytes, errors, fns } = setup();
    const acl = 0x300;
    bytes.set([1, 1, 0, 0, 0, 0, 0, 16, 0, 0x10, 0, 0], SID); // S-1-16-4096
    fns.InitializeAcl.handler([acl, 256, 2]);
    assert.equal(fns.AddMandatoryAce.handler([acl, 2, 0, 0x1234, SID]), 0);
    assert.equal(errors.at(-1), 87);
    assert.equal(fns.AddMandatoryAce.handler([acl, 2, 0, 1, SID]), 1);
    assert.deepEqual([...bytes.subarray(acl + 8, acl + 12)], [0x11, 0, 20, 0]);
});

test('DuplicateTokenEx makes a primary token or an impersonation one, as asked', ()=>{
    const { errors, fns, dword } = setup();
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    const token = dword(OUT);
    assert.equal(fns.DuplicateTokenEx.handler([token, 0, 0, 2, 2, OUT]), 1);
    assert.equal(fns.GetTokenInformation.handler([dword(OUT), 9, BUFFER, 4, NEEDED]), 1);
    assert.equal(dword(BUFFER), 2, 'SecurityImpersonation');
    assert.equal(fns.DuplicateTokenEx.handler([token, 0, 0, 2, 1, OUT]), 1);
    assert.equal(fns.GetTokenInformation.handler([dword(OUT), 9, BUFFER, 4, NEEDED]), 0,
        'a primary token has no impersonation level');
    assert.equal(errors.at(-1), 87);
});

test('TokenPrivileges lists the held privileges, change-notify enabled', ()=>{
    const { errors, fns, dword } = setup();
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    const token = dword(OUT);
    assert.equal(fns.GetTokenInformation.handler([token, 3, 0, 0, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    const count = (dword(NEEDED) - 4) / 12;
    errors.length = 0;
    assert.equal(fns.GetTokenInformation.handler([token, 3, BUFFER, dword(NEEDED), NEEDED]), 1);
    assert.equal(errors.length, 0, 'a success leaves the last error alone');
    assert.equal(dword(BUFFER), count);
    const changeNotify = Array.from({ length: count }, (_, at)=>BUFFER + 4 + at * 12)
        .find(at=>dword(at) === 23);
    assert.ok(changeNotify !== undefined);
    assert.equal(dword(changeNotify + 8), 3);
});

test('the default DACL can be set to none, and is answered so', ()=>{
    const { bytes, errors, fns, dword } = setup();
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    const token = dword(OUT);
    assert.equal(fns.SetTokenInformation.handler([token, 6, 0, 0]), 0);
    assert.equal(errors.at(-1), 24, 'ERROR_BAD_LENGTH');
    assert.equal(fns.SetTokenInformation.handler([token, 6, 0, 4]), 0);
    assert.equal(errors.at(-1), 998, 'ERROR_NOACCESS');
    bytes.fill(0, BUFFER, BUFFER + 4);
    assert.equal(fns.SetTokenInformation.handler([token, 6, BUFFER, 4]), 1);
    assert.equal(fns.GetTokenInformation.handler([token, 6, BUFFER, 64, NEEDED]), 1);
    assert.equal(dword(BUFFER), 0);
    assert.equal(dword(NEEDED), 4);
});

test('AccessCheck reads a self-relative descriptor; a null DACL grants the mapping\'s all', ()=>{
    const { bytes, fns, dword } = setup();
    fns.OpenProcessToken.handler([CURRENT_PROCESS, TOKEN_QUERY, OUT]);
    const token = dword(OUT);
    const { bytes: descriptor } = selfRelativeDescriptor({ dacl: null });
    bytes.set(descriptor, BUFFER);
    const mapping = 0x500;
    [0x120001, 0x120002, 0x120004, 0x1f0001]
        .forEach((value, at)=>new DataView(bytes.buffer).setUint32(mapping + at * 4, value, true));
    new DataView(bytes.buffer).setUint32(NEEDED, 64, true);
    assert.equal(fns.IsValidSecurityDescriptor.handler([BUFFER]), 1);
    assert.equal(fns.AccessCheck.handler([BUFFER, token, 0x02000000, mapping, 0x580, NEEDED,
        0x5c0, 0x5c4]), 1);
    assert.equal(dword(0x5c4), 1);
    assert.equal(dword(0x5c0), 0x1f0001);
});

test('LookupAccountName finds a service account by the name without its space', ()=>{
    const { bytes, fns, dword } = setup();
    bytes.set([...'LocalService'].map(c=>c.charCodeAt(0)).concat(0), 0x300);
    new DataView(bytes.buffer).setUint32(NEEDED, 64, true);
    new DataView(bytes.buffer).setUint32(0x5f0, 64, true);
    assert.equal(fns.LookupAccountNameA.handler([0, 0x300, SID, NEEDED, 0x400, 0x5f0, 0x5f4]), 1);
    assert.deepEqual([...bytes.subarray(SID, SID + 12)], [1, 1, 0, 0, 0, 0, 0, 5, 19, 0, 0, 0]);
    assert.equal(dword(0x5f4), 5, 'SidTypeWellKnownGroup');
});

test('ConvertStringSidToSid reads hex anywhere, and wants a sub-authority', ()=>{
    const { bytes, errors, fns, dword } = setup();
    bytes.set([...'S-0x1-0XC-0x1a'].map(c=>c.charCodeAt(0)).concat(0), 0x300);
    assert.equal(fns.ConvertStringSidToSidA.handler([0x300, OUT]), 1);
    assert.deepEqual([...bytes.subarray(dword(OUT), dword(OUT) + 12)],
        [1, 1, 0, 0, 0, 0, 0, 12, 26, 0, 0, 0]);
    bytes.set([...'S-1-5'].map(c=>c.charCodeAt(0)).concat(0), 0x300);
    assert.equal(fns.ConvertStringSidToSidA.handler([0x300, OUT]), 0);
    assert.equal(errors.at(-1), 1337);
});

test('SaferCreateLevel opens a level, SaferComputeTokenFromLevel makes a token at it', ()=>{
    // Steam's client starts programs with a token computed at the normal
    // user's level; one that restricts nothing may be asked for as no token.
    const { errors, fns, dword, table } = setup();
    const SAFER_SCOPEID_USER = 2;
    const SAFER_LEVELID_NORMALUSER = 0x20000;
    const SAFER_LEVELID_FULLYTRUSTED = 0x40000;
    const SAFER_TOKEN_NULL_IF_EQUAL = 1;
    assert.equal(fns.SaferCreateLevel.handler([SAFER_SCOPEID_USER, SAFER_LEVELID_NORMALUSER, 1,
        OUT, 0]), 1);
    const level = dword(OUT);
    assert.equal(table.get(level)?.type, 'saferLevel');
    assert.equal(fns.SaferComputeTokenFromLevel.handler([level, 0, NEEDED, 0, 0]), 1);
    assert.equal(table.get(dword(NEEDED))?.type, 'token');
    assert.equal(table.get(dword(NEEDED))?.object.process, CURRENT_PROCESS,
        'made from the process\'s own when none is given');

    assert.equal(fns.SaferCreateLevel.handler([SAFER_SCOPEID_USER, SAFER_LEVELID_FULLYTRUSTED, 1,
        OUT, 0]), 1);
    assert.equal(fns.SaferComputeTokenFromLevel.handler([dword(OUT), 0, NEEDED,
        SAFER_TOKEN_NULL_IF_EQUAL, 0]), 1);
    assert.equal(dword(NEEDED), 0, 'fully trusted changes nothing: no token');

    assert.equal(fns.SaferCreateLevel.handler([3, SAFER_LEVELID_NORMALUSER, 1, OUT, 0]), 0);
    assert.equal(fns.SaferCreateLevel.handler([SAFER_SCOPEID_USER, 0x1234, 1, OUT, 0]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
    assert.equal(fns.SaferCloseLevel.handler([level]), 1);
});
