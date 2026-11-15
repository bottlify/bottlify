/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
 *     readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void,
 *     teb: () => number }} host
 * @returns {Record<string, Entry>}
 */
export function createSecurityFunctions(host){
    const { advapi32 } = host;
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
        const kept = host.readMemory(slot, 4).slice();
        try
        {
            if (entry.handler(args) !== 0)
            {
                return STATUS_SUCCESS;
            }
            const bytes = host.readMemory(slot, 4);
            const error = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
            return STATUS_OF_ERROR.get(error) ?? STATUS_UNSUCCESSFUL;
        }
        finally
        {
            host.writeMemory(slot, kept);
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
