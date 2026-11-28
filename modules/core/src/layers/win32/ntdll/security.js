/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The Rtl forms of the SID, ACL and security descriptor calls, over advapi32's.
 *
 * On Windows advapi32's are these, a BOOL and the last error made of the
 * status in between. So the two are one implementation here too: where the
 * Rtl form answers what advapi32's does it is the same entry, and where it
 * answers a status the advapi32 call is made and its error turned back into
 * the status, the thread's last error left as it was - an Rtl call does not
 * set it.
 */

const STATUS_SUCCESS = 0;
const STATUS_UNSUCCESSFUL = 0xc0000001;
const STATUS_INVALID_SID = 0xc0000078;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_UNKNOWN_REVISION = 0xc0000058;
const SECURITY_DESCRIPTOR_REVISION = 1;
/** SECURITY_DESCRIPTOR_CONTROL's bits these read. */
const SE_OWNER_DEFAULTED = 0x0001;
const SE_GROUP_DEFAULTED = 0x0002;
const SE_SELF_RELATIVE = 0x8000;
/** ACL_REVISION and ACL_REVISION_DS, the revisions an ACL has; and its header's size. */
const MIN_ACL_REVISION = 2;
const MAX_ACL_REVISION = 4;
const ACL_HEADER = 8;

/** The Win32 errors these calls fail with, as the statuses they were made of. */
const STATUS_OF_ERROR = new Map([
    [87, 0xc000000d], // ERROR_INVALID_PARAMETER: STATUS_INVALID_PARAMETER
    [122, 0xc0000023], // ERROR_INSUFFICIENT_BUFFER: STATUS_BUFFER_TOO_SMALL
    [1305, 0xc0000059], // ERROR_REVISION_MISMATCH: STATUS_REVISION_MISMATCH
    [1336, 0xc0000077], // ERROR_INVALID_ACL: STATUS_INVALID_ACL
    [1337, STATUS_INVALID_SID], // ERROR_INVALID_SID
    [1338, 0xc0000079], // ERROR_INVALID_SECURITY_DESCR: STATUS_INVALID_SECURITY_DESCR
    [1344, 0xc0000099], // ERROR_ALLOTTED_SPACE_EXCEEDED: STATUS_ALLOTTED_SPACE_EXCEEDED
]);

/** The TEB's LastErrorValue, 32-bit. */
const LAST_ERROR = 0x34;

/** The Rtl names that answer exactly what advapi32's do. */
const SAME = {
    RtlFreeSid: 'FreeSid',
    RtlLengthSid: 'GetLengthSid',
    RtlLengthRequiredSid: 'GetSidLengthRequired',
    RtlSubAuthoritySid: 'GetSidSubAuthority',
    RtlSubAuthorityCountSid: 'GetSidSubAuthorityCount',
    RtlIdentifierAuthoritySid: 'GetSidIdentifierAuthority',
    RtlValidSid: 'IsValidSid',
    RtlEqualSid: 'EqualSid',
    RtlEqualPrefixSid: 'EqualPrefixSid',
    RtlValidSecurityDescriptor: 'IsValidSecurityDescriptor',
    RtlLengthSecurityDescriptor: 'GetSecurityDescriptorLength',
    RtlValidAcl: 'IsValidAcl',
};

/** The Rtl names that answer a status where advapi32's answers a BOOL, the arguments the same. */
const AS_STATUS = {
    RtlInitializeSid: 'InitializeSid',
    RtlCopySid: 'CopySid',
    RtlCreateSecurityDescriptor: 'InitializeSecurityDescriptor',
    RtlMakeSelfRelativeSD: 'MakeSelfRelativeSD',
    RtlAbsoluteToSelfRelativeSD: 'MakeSelfRelativeSD',
    RtlCreateAcl: 'InitializeAcl',
    RtlAddAccessAllowedAce: 'AddAccessAllowedAce',
    RtlGetAce: 'GetAce',
};

/**
 * @typedef {{ argBytes: number, handler: Function }} Entry
 */

/**
 * @param {{ advapi32: Record<string, Entry>,
 *     guest: import('../common/guest.js').Guest,
 *     teb: () => number }} host
 * @returns {Record<string, Entry>}
 */
export function createSecurityFunctions(host){
    const { advapi32, guest } = host;
    /** @type {Record<string, Entry>} */
    const table = {};
    for (const [rtl, name] of Object.entries(SAME))
    {
        if (advapi32[name])
        {
            table[rtl] = advapi32[name];
        }
    }

    /**
     * advapi32's call made, its BOOL answered as a status, the caller's last
     * error put back.
     *
     * @param {Entry} entry @param {number[]} args
     */
    const status = (entry, args)=>{
        const slot = (host.teb() + LAST_ERROR) >>> 0;
        const kept = guest.u32(slot);
        try
        {
            if (entry.handler(args) !== 0)
            {
                return STATUS_SUCCESS;
            }
            const error = guest.u32(slot);
            return STATUS_OF_ERROR.get(error) ?? STATUS_UNSUCCESSFUL;
        }
        finally
        {
            guest.set32(slot, kept);
        }
    };
    for (const [rtl, name] of Object.entries(AS_STATUS))
    {
        const entry = advapi32[name];
        if (entry)
        {
            table[rtl] = {
                argBytes: entry.argBytes,
                /** @param {number[]} args */
                handler: args=>status(entry, args),
            };
        }
    }

    /**
     * NTSTATUS RtlGetOwnerSecurityDescriptor(PSECURITY_DESCRIPTOR, PSID *Owner,
     *   PBOOLEAN OwnerDefaulted) and the group's twin: the SID where the
     * descriptor keeps it (a pointer, or an offset in a self-relative one) and
     * its defaulted bit as a BOOLEAN - one byte where advapi32's is a BOOL.
     *
     * @param {number} slot  the field's offset in the absolute layout
     * @param {number} defaultedBit  SE_OWNER_DEFAULTED or SE_GROUP_DEFAULTED
     */
    const sidOf = (slot, defaultedBit)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([descriptor, out, defaulted])=>{
            if ((descriptor >>> 0) === 0)
            {
                return STATUS_INVALID_PARAMETER;
            }
            if ((guest.u32(descriptor) & 0xff) !== SECURITY_DESCRIPTOR_REVISION)
            {
                return STATUS_UNKNOWN_REVISION;
            }
            const control = guest.u16(descriptor + 2);
            const value = guest.u32(descriptor + slot);
            const sid = (control & SE_SELF_RELATIVE) === 0 || value === 0 ? value
                : (descriptor + value) >>> 0;
            guest.set32(out, sid);
            guest.set8(wholeAddress(defaulted),
                sid !== 0 && (control & defaultedBit) !== 0 ? 1 : 0);
            return STATUS_SUCCESS;
        },
    });
    table.RtlGetOwnerSecurityDescriptor = sidOf(4, SE_OWNER_DEFAULTED);
    table.RtlGetGroupSecurityDescriptor = sidOf(8, SE_GROUP_DEFAULTED);

    /**
     * BOOLEAN RtlFirstFreeAce(PACL Acl, PVOID *FirstFree)
     *
     * Where the next ACE would go, after the ACL's last: NULL with TRUE when
     * the ACL is full, FALSE for a revision no ACL has or ACEs that run past
     * its size.
     */
    table.RtlFirstFreeAce = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([acl, out])=>{
            guest.set32(out, 0);
            const revision = guest.u32(acl) & 0xff;
            if (revision < MIN_ACL_REVISION || revision > MAX_ACL_REVISION)
            {
                return 0;
            }
            const end = wholeAddress(acl) + guest.u16(acl + 2);
            const count = guest.u16(acl + 4);
            let at = wholeAddress(acl) + ACL_HEADER;
            for (let index = 0; index < count; index++)
            {
                if (at >= end)
                {
                    return 0;
                }
                at += guest.u16(at + 2);
            }
            if (at < end)
            {
                guest.set32(out, at);
            }
            return 1;
        },
    };

    if (advapi32.AllocateAndInitializeSid)
    {
        const entry = advapi32.AllocateAndInitializeSid;
        /**
         * NTSTATUS RtlAllocateAndInitializeSid(PSID_IDENTIFIER_AUTHORITY, BYTE Count,
         *   DWORD Sub0..Sub7, PSID *Sid)
         *
         * More than eight subauthorities is no SID: STATUS_INVALID_SID.
         */
        table.RtlAllocateAndInitializeSid = {
            argBytes: entry.argBytes,
            /** @param {number[]} args */
            handler: args=>((args[1] & 0xff) > 8 ? STATUS_INVALID_SID : status(entry, args)),
        };
    }
    return table;
}
