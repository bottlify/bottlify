/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Access tokens: what a program opens to ask who it is running as.
 *
 * There is one account, and it is an administrator. That is not a courtesy:
 * an installer asks before it does anything else, and one told it is not
 * privileged stops with an error rather than installing to a place it may not
 * write to. The question is asked through a sequence with two documented
 * failures in it, and a program of the NT era is written against exactly that
 * sequence: the thread has no token of its own (ERROR_NO_TOKEN, and the
 * process's is opened instead), and the groups do not fit in a buffer that
 * was not sized first (ERROR_INSUFFICIENT_BUFFER, with the size needed). A
 * stub that fails either differently sends the program down the branch for a
 * machine it was not written for.
 *
 * A SID is laid out in guest memory the way Windows lays it out -- revision,
 * sub-authority count, a six-byte authority, the sub-authorities -- because
 * the program compares one it built against one it read, byte for byte.
 */

/** Codes this surface reports. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_TOKEN = 1008;
const ERROR_NO_SUCH_PRIVILEGE = 1313;

/**
 * The privileges Windows numbers, by name, as LookupPrivilegeValue answers
 * them: the low part of the LUID, and a high part of zero. Fixed numbers,
 * not a table read from anywhere -- these are the same on every machine.
 */
const PRIVILEGES = new Map([
    ['SeCreateTokenPrivilege', 2], ['SeAssignPrimaryTokenPrivilege', 3],
    ['SeLockMemoryPrivilege', 4], ['SeIncreaseQuotaPrivilege', 5],
    ['SeMachineAccountPrivilege', 6], ['SeTcbPrivilege', 7], ['SeSecurityPrivilege', 8],
    ['SeTakeOwnershipPrivilege', 9], ['SeLoadDriverPrivilege', 10],
    ['SeSystemProfilePrivilege', 11], ['SeSystemtimePrivilege', 12],
    ['SeProfileSingleProcessPrivilege', 13], ['SeIncreaseBasePriorityPrivilege', 14],
    ['SeCreatePagefilePrivilege', 15], ['SeCreatePermanentPrivilege', 16],
    ['SeBackupPrivilege', 17], ['SeRestorePrivilege', 18], ['SeShutdownPrivilege', 19],
    ['SeDebugPrivilege', 20], ['SeAuditPrivilege', 21], ['SeSystemEnvironmentPrivilege', 22],
    ['SeChangeNotifyPrivilege', 23], ['SeRemoteShutdownPrivilege', 24],
    ['SeUndockPrivilege', 25], ['SeSyncAgentPrivilege', 26],
    ['SeEnableDelegationPrivilege', 27], ['SeManageVolumePrivilege', 28],
    ['SeImpersonatePrivilege', 29], ['SeCreateGlobalPrivilege', 30],
]);

/** The longest privilege name read out of the guest. */
const MAX_PRIVILEGE_NAME = 64;

/** TOKEN_INFORMATION_CLASS values this build answers. */
const TokenUser = 1;
const TokenGroups = 2;

/** SID_AND_ATTRIBUTES: a pointer and a DWORD. */
const SID_AND_ATTRIBUTES_SIZE = 8;

/** SE_GROUP_MANDATORY | SE_GROUP_ENABLED_BY_DEFAULT | SE_GROUP_ENABLED. */
const GROUP_ATTRIBUTES = 0x00000007;

/** The pseudo-handle GetCurrentProcess hands out. */
const CURRENT_PROCESS = 0xffffffff;

/**
 * A SID as its authority and sub-authorities: S-1-<authority>-<sub>...
 *
 * @typedef {Object} Sid
 * @property {number} authority
 * @property {number[]} subAuthorities
 */

/** S-1-5-21-<three>-<rid>: a local account of this machine. */
const USER_SID = { authority: 5, subAuthorities: [21, 0x1a2b3c4d, 0x2b3c4d5e, 0x3c4d5e6f, 1000] };

/**
 * The groups every interactive administrator is in, in the order Windows
 * lists them: the domain's users, Everyone, BUILTIN\Administrators,
 * BUILTIN\Users, INTERACTIVE, Authenticated Users.
 *
 * @type {Sid[]}
 */
const GROUP_SIDS = [
    { authority: 5, subAuthorities: [21, 0x1a2b3c4d, 0x2b3c4d5e, 0x3c4d5e6f, 513] },
    { authority: 1, subAuthorities: [0] },
    { authority: 5, subAuthorities: [32, 544] },
    { authority: 5, subAuthorities: [32, 545] },
    { authority: 5, subAuthorities: [4] },
    { authority: 5, subAuthorities: [11] },
];

/** @param {Sid} sid @returns {Uint8Array} the SID, laid out */
const sidBytes = sid=>{
    const bytes = new Uint8Array(8 + 4 * sid.subAuthorities.length);
    bytes[0] = 1;
    bytes[1] = sid.subAuthorities.length;
    // The authority is six bytes, big-endian; every one Windows defines fits
    // in the last of them.
    bytes[7] = sid.authority;
    for (let at = 0; at < sid.subAuthorities.length; at++)
    {
        new DataView(bytes.buffer).setUint32(8 + at * 4, sid.subAuthorities[at] >>> 0, true);
    }
    return bytes;
};

/**
 * @typedef {Object} TokenHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any }} handles
 *           The one handle table: a token is closed with CloseHandle like
 *           everything else.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {TokenHost} host
 */
export function createTokenFunctions(host){
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} handle */
    const isToken = handle=>{
        try
        {
            return host.handles.resolve(handle >>> 0, 'token') !== null;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /**
     * What GetTokenInformation writes: the fixed part, then the SIDs the
     * pointers in it name, all inside the one buffer the caller gave.
     *
     * @param {number} tokenClass
     * @returns {{ fixed: Uint8Array, sids: Uint8Array[] } | null}
     */
    const information = tokenClass=>{
        switch (tokenClass >>> 0)
        {
            case TokenUser:
                return {
                    fixed: new Uint8Array(SID_AND_ATTRIBUTES_SIZE), sids: [sidBytes(USER_SID)],
                };
            case TokenGroups:
            {
                const fixed = new Uint8Array(4 + SID_AND_ATTRIBUTES_SIZE * GROUP_SIDS.length);
                new DataView(fixed.buffer).setUint32(0, GROUP_SIDS.length, true);
                for (let at = 0; at < GROUP_SIDS.length; at++)
                {
                    new DataView(fixed.buffer).setUint32(
                        4 + at * SID_AND_ATTRIBUTES_SIZE + 4, GROUP_ATTRIBUTES, true);
                }
                return { fixed, sids: GROUP_SIDS.map(sidBytes) };
            }
            default:
                return null;
        }
    };

    return {
        /**
         * BOOL OpenThreadToken(HANDLE hThread, DWORD DesiredAccess,
         *   BOOL OpenAsSelf, PHANDLE TokenHandle)
         *
         * No thread here impersonates anyone, so no thread has a token of its
         * own -- which is what a thread of an ordinary program answers on
         * Windows too, and the failure a program expects before it asks for
         * the process's token instead.
         */
        OpenThreadToken: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>{
                void args;
                return fail(ERROR_NO_TOKEN);
            },
        },

        /**
         * BOOL OpenProcessToken(HANDLE ProcessHandle, DWORD DesiredAccess,
         *   PHANDLE TokenHandle)
         *
         * Only the running process has a token to open. The access asked
         * for is granted whatever it is: there is nobody to refuse. The last
         * error is left as it was, as a call that succeeds leaves it: a
         * program reads ERROR_NO_TOKEN back after this to know the thread's
         * token was the one it lacked, and takes a zero for "not privileged".
         */
        OpenProcessToken: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([process, , out])=>{
                if ((process >>> 0) !== CURRENT_PROCESS)
                {
                    try
                    {
                        host.handles.resolve(process >>> 0, 'process');
                    }
                    catch (e){
                        void e;
                        return fail(ERROR_INVALID_HANDLE);
                    }
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, host.handles.open('token', { process: process >>> 0 }));
                return 1;
            },
        },

        /**
         * BOOL GetTokenInformation(HANDLE TokenHandle,
         *   TOKEN_INFORMATION_CLASS TokenInformationClass, LPVOID TokenInformation,
         *   DWORD TokenInformationLength, PDWORD ReturnLength)
         *
         * Two calls, by design: the first with no room learns how much is
         * needed and fails saying so, the second gets the structure with its
         * SIDs laid out after it, inside the same buffer. The pointers in the
         * structure are absolute, so nothing here can be answered without
         * knowing where the buffer is.
         */
        GetTokenInformation: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([token, tokenClass, buffer, length, returnLength])=>{
                if (!isToken(token))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const answer = information(tokenClass);
                if (!answer)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const needed = answer.fixed.length
                    + answer.sids.reduce((sum, sid)=>sum + sid.length, 0);
                if ((returnLength >>> 0) !== 0)
                {
                    writeDword(returnLength >>> 0, needed);
                }
                if ((buffer >>> 0) === 0 || (length >>> 0) < needed)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                const whole = new Uint8Array(needed);
                whole.set(answer.fixed);
                // The first pointer slot is where the class puts its first
                // SID pointer: TokenUser has it at zero, TokenGroups after
                // the count.
                const firstSlot = (tokenClass >>> 0) === TokenGroups ? 4 : 0;
                let at = answer.fixed.length;
                for (let index = 0; index < answer.sids.length; index++)
                {
                    whole.set(answer.sids[index], at);
                    new DataView(whole.buffer).setUint32(
                        firstSlot + index * SID_AND_ATTRIBUTES_SIZE, (buffer >>> 0) + at, true);
                    at += answer.sids[index].length;
                }
                host.writeMemory(buffer >>> 0, whole);
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * BOOL EqualSid(PSID pSid1, PSID pSid2)
         *
         * Byte for byte over the length the count implies, which is how two
         * SIDs are equal and the only way a program can compare one it built
         * against one it read.
         */
        EqualSid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                if ((first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const left = host.readMemory(first >>> 0, 8);
                const length = 8 + 4 * left[1];
                const whole = host.readMemory(first >>> 0, length);
                const other = host.readMemory(second >>> 0, length);
                host.setLastError(ERROR_SUCCESS);
                return whole.every((byte, at)=>byte === other[at]) ? 1 : 0;
            },
        },

        /**
         * BOOL LookupPrivilegeValueA(LPCSTR lpSystemName, LPCSTR lpName, PLUID lpLuid)
         *
         * The system name is not read: there is one machine here, and a
         * program names the local one with NULL.
         */
        LookupPrivilegeValueA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, name, out])=>{
                if ((name >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const value = PRIVILEGES.get(host.readCString(name >>> 0, MAX_PRIVILEGE_NAME));
                if (value === undefined)
                {
                    return fail(ERROR_NO_SUCH_PRIVILEGE);
                }
                writeDword(out >>> 0, value);
                writeDword((out >>> 0) + 4, 0);
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * BOOL AdjustTokenPrivileges(HANDLE TokenHandle, BOOL DisableAllPrivileges,
         *   PTOKEN_PRIVILEGES NewState, DWORD BufferLength,
         *   PTOKEN_PRIVILEGES PreviousState, PDWORD ReturnLength)
         *
         * Granted, whatever was asked: the token is an administrator's and
         * nothing here enforces a privilege, so enabling one changes nothing
         * and refusing one would send a program down its unprivileged path
         * for no reason. The previous state, when asked for, is an empty
         * list -- nothing was enabled before, and the count says so.
         */
        AdjustTokenPrivileges: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([token, , newState, , previous, returnLength])=>{
                if (!isToken(token))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((newState >>> 0) === 0 && (previous >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((returnLength >>> 0) !== 0)
                {
                    writeDword(returnLength >>> 0, 4);
                }
                if ((previous >>> 0) !== 0)
                {
                    writeDword(previous >>> 0, 0);
                }
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * DWORD GetLengthSid(PSID pSid)
         */
        GetLengthSid: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([sid])=>8 + 4 * host.readMemory(sid >>> 0, 2)[1],
        },

        /**
         * BOOL IsValidSid(PSID pSid)
         *
         * The revision is one and the count fits the format's eight, which is
         * all a SID can be checked for without a directory behind it.
         */
        IsValidSid: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([sid])=>{
                if ((sid >>> 0) === 0)
                {
                    return 0;
                }
                const head = host.readMemory(sid >>> 0, 2);
                return head[0] === 1 && head[1] <= 8 ? 1 : 0;
            },
        },

        /**
         * BOOL CheckTokenMembership(HANDLE TokenHandle, PSID SidToCheck, PBOOL IsMember)
         *
         * A NULL token means the caller's own, and membership is what the
         * groups above say: the same answer a program gets by walking them,
         * asked in one call.
         */
        CheckTokenMembership: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([token, sid, out])=>{
                if ((token >>> 0) !== 0 && !isToken(token))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((sid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const length = 8 + 4 * host.readMemory(sid >>> 0, 2)[1];
                const member = isTokenMember(host.readMemory(sid >>> 0, length));
                host.writeMemory(out >>> 0, new Uint8Array([member ? 1 : 0, 0, 0, 0]));
                return 1;
            },
        },
    };
}

/** BUILTIN\Administrators, laid out: what a program compares the groups against. */
export const ADMINISTRATORS_SID = sidBytes(GROUP_SIDS[2]);

/**
 * Whether the one account's token holds a SID, laid out: the user's own or
 * one of its groups. The answer CheckTokenMembership gives, for the libraries
 * that ask it on a program's behalf.
 *
 * @param {Uint8Array} wanted
 */
export const isTokenMember = wanted=>[USER_SID, ...GROUP_SIDS].map(sidBytes).some(held=>
    held.length === wanted.length && held.every((byte, at)=>byte === wanted[at]));
