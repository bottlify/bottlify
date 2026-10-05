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

/** The native calls' table, published by ntdll beside its own. */
export const TOKEN_NATIVES = Symbol('tokenNatives');

/** Statuses the native calls answer. */
const STATUS_SUCCESS = 0;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;

/** Codes this surface reports. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_TOKEN = 1008;
const ERROR_NO_SUCH_PRIVILEGE = 1313;
const ERROR_ACCESS_DENIED = 5;
const ERROR_UNKNOWN_REVISION = 1305;
const ERROR_INVALID_ACL = 1336;
const ERROR_INVALID_SID = 1337;
const ERROR_INVALID_SECURITY_DESCR = 1338;
const ERROR_ALLOTTED_SPACE_EXCEEDED = 1344;

/**
 * An absolute SECURITY_DESCRIPTOR: revision, a pad byte, the control word,
 * then pointers to the owner, the group, the SACL and the DACL.
 */
const SD = Object.freeze({ REVISION: 0, CONTROL: 2, OWNER: 4, GROUP: 8, SACL: 12, DACL: 16,
    SIZE: 20 });
const SECURITY_DESCRIPTOR_REVISION = 1;
const SE_OWNER_DEFAULTED = 0x0001;
const SE_GROUP_DEFAULTED = 0x0002;
const SE_DACL_PRESENT = 0x0004;
const SE_DACL_DEFAULTED = 0x0008;
const SE_SELF_RELATIVE = 0x8000;

/** An ACL's header: revision, a pad, its size, its ACE count, a pad. */
const ACL = Object.freeze({ REVISION: 0, SIZE: 2, COUNT: 4, HEADER: 8 });
/** The revisions an ACL may be made with: ACL_REVISION and ACL_REVISION_DS. */
const ACL_REVISIONS = new Set([2, 4]);
/** An ACE: type, flags, size, then the mask and the SID of an access ACE. */
const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACCESS_DENIED_ACE_TYPE = 1;

/** The generic rights, mapped through a GENERIC_MAPPING, and MAXIMUM_ALLOWED. */
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const GENERIC_EXECUTE = 0x20000000;
const GENERIC_ALL = 0x10000000;
const MAXIMUM_ALLOWED = 0x02000000;

/** PRIVILEGE_SET with no privilege in it: its count and its control word. */
const PRIVILEGE_SET_EMPTY = 8;

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
const TokenOwner = 4;
const TokenPrimaryGroup = 5;
const TokenType = 8;
const TokenSessionId = 12;

/** TOKEN_TYPE: a process's own token, and one made to impersonate with. */
const TOKEN_PRIMARY = 1;
const TOKEN_IMPERSONATION = 2;

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

/**
 * Who owns what the account creates, and its primary group: an
 * administrator's token names BUILTIN\Administrators, not the user, as the
 * owner, and the domain's users as the group. A setup that checks it is an
 * administrator may read the owner rather than the groups.
 */
const DEFAULT_OWNER = GROUP_SIDS[2];
const PRIMARY_GROUP = GROUP_SIDS[0];

/** The local system, whom an object's default DACL lets in beside the administrators. */
const SYSTEM_SID = { authority: 5, subAuthorities: [18] };

/** SECURITY_INFORMATION bits GetKernelObjectSecurity is asked for. */
const OWNER_SECURITY_INFORMATION = 0x1;
const GROUP_SECURITY_INFORMATION = 0x2;
const DACL_SECURITY_INFORMATION = 0x4;
/** Every standard and specific right: what GENERIC_ALL comes to on any object. */
const ALL_RIGHTS = 0x001fffff;

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
 * @property {(bytes: number) => number} allocate  LocalFree-compatible.
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

    /** @param {boolean} wide */
    const convertSid = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([sid, out])=>{
            if ((sid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const head = host.readMemory(sid >>> 0, 8);
            if (head[0] !== 1 || head[1] > 15)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const body = host.readMemory(sid >>> 0, 8 + 4 * head[1]);
            const view = new DataView(body.buffer, body.byteOffset, body.length);
            const authority = view.getUint16(2) * 2 ** 32 + view.getUint32(4);
            let text = `S-1-${authority >= 2 ** 32 ? `0x${authority.toString(16)}` : authority}`;
            for (let at = 0; at < head[1]; at++)
            {
                text += `-${view.getUint32(8 + at * 4, true)}`;
            }
            const unit = wide ? 2 : 1;
            const memory = new Uint8Array((text.length + 1) * unit);
            for (let at = 0; at < text.length; at++)
            {
                memory[at * unit] = text.charCodeAt(at);
            }
            const block = host.allocate(memory.length);
            host.writeMemory(block, memory);
            writeDword(out >>> 0, block);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

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

    /** @param {number} value @returns {Uint8Array} */
    const dwordBytes = value=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    };

    /**
     * What GetTokenInformation writes: the fixed part, then the SIDs the
     * pointers in it name, all inside the one buffer the caller gave. The
     * pointers sit `stride` apart from `slot` on.
     *
     * @param {number} tokenClass @param {any} token
     * @returns {{ fixed: Uint8Array, sids: Uint8Array[], slot?: number,
     *             stride?: number } | null}
     */
    const information = (tokenClass, token)=>{
        switch (tokenClass >>> 0)
        {
            case TokenUser:
                return {
                    fixed: new Uint8Array(SID_AND_ATTRIBUTES_SIZE), sids: [sidBytes(USER_SID)],
                };
            // TOKEN_OWNER and TOKEN_PRIMARY_GROUP: one SID pointer each.
            case TokenOwner:
                return { fixed: new Uint8Array(4), sids: [sidBytes(DEFAULT_OWNER)] };
            case TokenPrimaryGroup:
                return { fixed: new Uint8Array(4), sids: [sidBytes(PRIMARY_GROUP)] };
            // DuplicateToken makes an impersonation token; what OpenProcessToken
            // opens is the primary one.
            case TokenType:
                return {
                    fixed: dwordBytes(token?.impersonationLevel === undefined
                        ? TOKEN_PRIMARY : TOKEN_IMPERSONATION),
                    sids: [],
                };
            // The one interactive session there is: the console's, zero on NT 5.
            case TokenSessionId:
                return { fixed: dwordBytes(0), sids: [] };
            case TokenGroups:
            {
                const fixed = new Uint8Array(4 + SID_AND_ATTRIBUTES_SIZE * GROUP_SIDS.length);
                new DataView(fixed.buffer).setUint32(0, GROUP_SIDS.length, true);
                for (let at = 0; at < GROUP_SIDS.length; at++)
                {
                    new DataView(fixed.buffer).setUint32(
                        4 + at * SID_AND_ATTRIBUTES_SIZE + 4, GROUP_ATTRIBUTES, true);
                }
                return { fixed, sids: GROUP_SIDS.map(sidBytes), slot: 4,
                    stride: SID_AND_ATTRIBUTES_SIZE };
            }
            default:
                return null;
        }
    };

    /** @param {number} address @returns {number} */
    const readDword = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @returns {number} */
    const readWord = address=>{
        const bytes = host.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array([value & 0xff, value >>> 8 & 0xff]));

    /** A SID in guest memory, laid out, or null when it is not one. @param {number} sid */
    const sidAt = sid=>{
        if ((sid >>> 0) === 0)
        {
            return null;
        }
        const head = host.readMemory(sid >>> 0, 2);
        return head[0] === 1 && head[1] <= 15 ? host.readMemory(sid >>> 0, 8 + 4 * head[1]).slice()
            : null;
    };

    /**
     * An absolute descriptor the caller made, or null: InitializeSecurity-
     * Descriptor's revision, and not the self-relative form this surface
     * does not build.
     *
     * @param {number} descriptor
     */
    const descriptorAt = descriptor=>{
        if ((descriptor >>> 0) === 0)
        {
            return null;
        }
        const head = host.readMemory(descriptor >>> 0, 4);
        return head[SD.REVISION] === SECURITY_DESCRIPTOR_REVISION
            && ((head[2] | head[3] << 8) & SE_SELF_RELATIVE) === 0 ? descriptor >>> 0 : null;
    };

    /**
     * The owner or group pointer of a descriptor, and the bit that says it
     * was defaulted.
     *
     * @param {number} slot @param {number} bit
     */
    const setSidOf = (slot, bit)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [descriptor, sid, defaulted])=>{
            const at = descriptorAt(descriptor);
            if (at === null)
            {
                return fail(ERROR_INVALID_SECURITY_DESCR);
            }
            writeDword(at + slot, sid >>> 0);
            const control = readWord(at + SD.CONTROL);
            writeWord(at + SD.CONTROL, defaulted ? control | bit : control & ~bit);
            return 1;
        },
    });

    /**
     * Each ACE of an ACL, walked by its sizes: its type, its mask and, for an
     * access ACE, its SID.
     *
     * @param {number} acl
     * @returns {{ type: number, mask: number, sid: Uint8Array | null, next: number }[] | null}
     */
    const acesOf = acl=>{
        const head = host.readMemory(acl >>> 0, ACL.HEADER);
        if (!ACL_REVISIONS.has(head[ACL.REVISION]))
        {
            return null;
        }
        const size = head[ACL.SIZE] | head[ACL.SIZE + 1] << 8;
        const count = head[ACL.COUNT] | head[ACL.COUNT + 1] << 8;
        const aces = [];
        let at = ACL.HEADER;
        for (let index = 0; index < count; index++)
        {
            if (at + 8 > size)
            {
                return null;
            }
            const ace = host.readMemory((acl >>> 0) + at, 4);
            const aceSize = ace[2] | ace[3] << 8;
            if (aceSize < 8 || at + aceSize > size)
            {
                return null;
            }
            const type = ace[0];
            const mask = readDword((acl >>> 0) + at + 4);
            const sid = type <= ACCESS_DENIED_ACE_TYPE ? sidAt((acl >>> 0) + at + 8) : null;
            aces.push({ type, mask, sid, next: at + aceSize });
            at += aceSize;
        }
        return aces;
    };

    /**
     * An access ACE appended after the last one; an ACL with no room for it
     * refuses it rather than writing past its end.
     *
     * @param {number} acl
     * @param {number} type
     * @param {number} mask
     * @param {number} sid
     */
    const addAce = (acl, type, mask, sid)=>{
        const aces = (acl >>> 0) === 0 ? null : acesOf(acl);
        if (aces === null)
        {
            return fail(ERROR_INVALID_ACL);
        }
        const bytes = sidAt(sid);
        if (bytes === null)
        {
            return fail(ERROR_INVALID_SID);
        }
        const at = aces.length === 0 ? ACL.HEADER : aces[aces.length - 1].next;
        const aceSize = 8 + bytes.length;
        if (at + aceSize > readWord((acl >>> 0) + ACL.SIZE))
        {
            return fail(ERROR_ALLOTTED_SPACE_EXCEEDED);
        }
        const ace = new Uint8Array(aceSize);
        ace[0] = type;
        ace[2] = aceSize & 0xff;
        ace[3] = aceSize >>> 8;
        new DataView(ace.buffer).setUint32(4, mask >>> 0, true);
        ace.set(bytes, 8);
        host.writeMemory((acl >>> 0) + at, ace);
        writeWord((acl >>> 0) + ACL.COUNT, aces.length + 1);
        return 1;
    };

    /**
     * The generic rights of a mask turned into the specific ones a
     * GENERIC_MAPPING names, the generic bits themselves taken out.
     *
     * @param {number} mask @param {number[]} mapping  read, write, execute, all
     */
    const mapGeneric = (mask, mapping)=>{
        let mapped = mask & ~(GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | GENERIC_ALL);
        [GENERIC_READ, GENERIC_WRITE, GENERIC_EXECUTE, GENERIC_ALL].forEach((bit, at)=>{
            if ((mask & bit) !== 0)
            {
                mapped |= mapping[at];
            }
        });
        return mapped >>> 0;
    };

    /**
     * OpenProcessToken's body, answering an error code: a process that is no
     * process is refused, and nowhere to put the handle is the caller's
     * mistake.
     *
     * @param {number} process @param {number} out
     */
    const openProcessToken = (process, out)=>{
        if ((process >>> 0) !== CURRENT_PROCESS)
        {
            try
            {
                host.handles.resolve(process >>> 0, 'process');
            }
            catch (e){
                void e;
                return ERROR_INVALID_HANDLE;
            }
        }
        if ((out >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        writeDword(out >>> 0, host.handles.open('token', { process: process >>> 0 }));
        return ERROR_SUCCESS;
    };

    /**
     * AdjustTokenPrivileges' body, answering an error code.
     *
     * @param {number} token @param {number} newState @param {number} previous
     * @param {number} returnLength
     */
    const adjustPrivileges = (token, newState, previous, returnLength)=>{
        if (!isToken(token))
        {
            return ERROR_INVALID_HANDLE;
        }
        if ((newState >>> 0) === 0 && (previous >>> 0) !== 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if ((returnLength >>> 0) !== 0)
        {
            writeDword(returnLength >>> 0, 4);
        }
        if ((previous >>> 0) !== 0)
        {
            writeDword(previous >>> 0, 0);
        }
        return ERROR_SUCCESS;
    };

    /** @param {number} code @returns {number} the status a native call answers it with */
    const statusOf = code=>(code === ERROR_SUCCESS ? STATUS_SUCCESS
        : code === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE : STATUS_ACCESS_VIOLATION);

    return {
        /**
         * The native calls over the same tokens, for ntdll to publish: a
         * status rather than a last error, and the last error left alone.
         * The one failure besides a bad handle is an out-pointer that is
         * null, which the kernel meets as an access violation.
         *
         * NTSTATUS NtOpenProcessToken(HANDLE, ACCESS_MASK, PHANDLE TokenHandle)
         * NTSTATUS NtOpenProcessTokenEx(HANDLE, ACCESS_MASK, ULONG HandleAttributes,
         *   PHANDLE TokenHandle)
         * NTSTATUS NtAdjustPrivilegesToken(HANDLE, BOOLEAN DisableAllPrivileges,
         *   PTOKEN_PRIVILEGES NewState, ULONG BufferLength,
         *   PTOKEN_PRIVILEGES PreviousState, PULONG ReturnLength)
         */
        [TOKEN_NATIVES]: {
            NtOpenProcessToken: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([process, , out])=>statusOf(openProcessToken(process, out)),
            },
            NtOpenProcessTokenEx: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([process, , , out])=>statusOf(openProcessToken(process, out)),
            },
            NtAdjustPrivilegesToken: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([token, , newState, , previous, returnLength])=>
                    statusOf(adjustPrivileges(token, newState, previous, returnLength)),
            },
        },

        /**
         * BOOL InitializeSecurityDescriptor(PSECURITY_DESCRIPTOR, DWORD dwRevision)
         *
         * An empty absolute descriptor: no owner, no group, no DACL -- which
         * grants everyone everything until a DACL is set.
         */
        InitializeSecurityDescriptor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([descriptor, revision])=>{
                if ((revision >>> 0) !== SECURITY_DESCRIPTOR_REVISION)
                {
                    return fail(ERROR_UNKNOWN_REVISION);
                }
                if ((descriptor >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const bytes = new Uint8Array(SD.SIZE);
                bytes[SD.REVISION] = SECURITY_DESCRIPTOR_REVISION;
                host.writeMemory(descriptor >>> 0, bytes);
                return 1;
            },
        },

        /** BOOL IsValidSecurityDescriptor(PSECURITY_DESCRIPTOR) */
        IsValidSecurityDescriptor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([descriptor])=>(descriptorAt(descriptor) === null
                ? fail(ERROR_INVALID_SECURITY_DESCR) : 1),
        },

        /** BOOL SetSecurityDescriptorOwner(PSECURITY_DESCRIPTOR, PSID, BOOL bOwnerDefaulted) */
        SetSecurityDescriptorOwner: setSidOf(SD.OWNER, SE_OWNER_DEFAULTED),

        /** BOOL SetSecurityDescriptorGroup(PSECURITY_DESCRIPTOR, PSID, BOOL bGroupDefaulted) */
        SetSecurityDescriptorGroup: setSidOf(SD.GROUP, SE_GROUP_DEFAULTED),

        /**
         * BOOL SetSecurityDescriptorDacl(PSECURITY_DESCRIPTOR, BOOL bDaclPresent,
         *   PACL pDacl, BOOL bDaclDefaulted)
         *
         * Present with a NULL ACL is the null DACL, which grants everything;
         * absent takes the pointer away.
         */
        SetSecurityDescriptorDacl: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([descriptor, present, acl, defaulted])=>{
                const at = descriptorAt(descriptor);
                if (at === null)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                let control = readWord(at + SD.CONTROL) & ~(SE_DACL_PRESENT | SE_DACL_DEFAULTED);
                if (present)
                {
                    control |= SE_DACL_PRESENT | (defaulted ? SE_DACL_DEFAULTED : 0);
                }
                writeWord(at + SD.CONTROL, control);
                writeDword(at + SD.DACL, present ? acl >>> 0 : 0);
                return 1;
            },
        },

        /**
         * BOOL InitializeAcl(PACL pAcl, DWORD nAclLength, DWORD dwAclRevision)
         *
         * An empty ACL of the size given, which is at least its header and a
         * whole number of DWORDs, and no more than a WORD holds.
         */
        InitializeAcl: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([acl, length, revision])=>{
                const size = length >>> 0;
                if ((acl >>> 0) === 0 || size < ACL.HEADER || size > 0xffff || size % 4 !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (!ACL_REVISIONS.has(revision >>> 0))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const bytes = new Uint8Array(ACL.HEADER);
                bytes[ACL.REVISION] = revision >>> 0;
                bytes[ACL.SIZE] = size & 0xff;
                bytes[ACL.SIZE + 1] = size >>> 8;
                host.writeMemory(acl >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL AddAccessAllowedAce(PACL pAcl, DWORD dwAceRevision, DWORD AccessMask, PSID pSid)
         *
         * The ACE goes after the last one, and an ACL with no room for it
         * refuses it rather than writing past its end.
         */
        AddAccessAllowedAce: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([acl, , mask, sid])=>addAce(acl, ACCESS_ALLOWED_ACE_TYPE, mask, sid),
        },

        /**
         * BOOL AddAce(PACL pAcl, DWORD dwAceRevision, DWORD dwStartingAceIndex,
         *             LPVOID pAceList, DWORD nAceListLength)
         *
         * ACEs already laid out, put in at an index -- MAXDWORD, or one past
         * the last, appends -- the ones from there on moved up behind them.
         */
        AddAce: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([acl, , index, list, length])=>{
                const aces = (acl >>> 0) === 0 ? null : acesOf(acl);
                if (aces === null)
                {
                    return fail(ERROR_INVALID_ACL);
                }
                const size = length >>> 0;
                if ((list >>> 0) === 0 || size === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const added = host.readMemory(list >>> 0, size).slice();
                let count = 0;
                for (let at = 0; at < size; count++)
                {
                    const aceSize = added[at + 2] | added[at + 3] << 8;
                    if (aceSize < 8 || at + aceSize > size)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    at += aceSize;
                }
                const end = aces.length === 0 ? ACL.HEADER : aces[aces.length - 1].next;
                if (end + size > readWord((acl >>> 0) + ACL.SIZE))
                {
                    return fail(ERROR_ALLOTTED_SPACE_EXCEEDED);
                }
                const at = (index >>> 0) >= aces.length ? end
                    : (index >>> 0) === 0 ? ACL.HEADER : aces[(index >>> 0) - 1].next;
                const moved = host.readMemory((acl >>> 0) + at, end - at).slice();
                host.writeMemory((acl >>> 0) + at, added);
                host.writeMemory((acl >>> 0) + at + size, moved);
                writeWord((acl >>> 0) + ACL.COUNT, aces.length + count);
                return 1;
            },
        },

        /**
         * BOOL AddAccessDeniedAce(PACL pAcl, DWORD dwAceRevision, DWORD AccessMask, PSID pSid)
         */
        AddAccessDeniedAce: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([acl, , mask, sid])=>addAce(acl, ACCESS_DENIED_ACE_TYPE, mask, sid),
        },

        /**
         * DWORD SetSecurityInfo(HANDLE, SE_OBJECT_TYPE, SECURITY_INFORMATION, PSID owner,
         *   PSID group, PACL dacl, PACL sacl)
         *
         * Taken and kept nowhere: the one account is the only one there is, so
         * a DACL on an object has nobody else to let in or keep out.
         */
        SetSecurityInfo: {
            argBytes: 28,
            handler: ()=>0,
        },

        /**
         * BOOL GetKernelObjectSecurity(HANDLE Handle, SECURITY_INFORMATION
         *   RequestedInformation, PSECURITY_DESCRIPTOR pSecurityDescriptor,
         *   DWORD nLength, LPDWORD lpnLengthNeeded)
         *
         * The object's descriptor, self-relative, with the parts asked for:
         * an object the one account made is owned by BUILTIN\Administrators,
         * as an elevated administrator's objects are, its group the account's
         * primary one, and its DACL the token's default -- everything to the
         * administrators and to the system. Too small a buffer is the
         * documented ERROR_INSUFFICIENT_BUFFER with the size needed, which is
         * how a caller learns it.
         */
        GetKernelObjectSecurity: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, requested, descriptor, length, needed])=>{
                const PSEUDO_HANDLES = new Set([0xffffffff, 0xfffffffe, 0xfffffffd]);
                let known = PSEUDO_HANDLES.has(handle >>> 0);
                try
                {
                    known = known || host.handles.resolve(handle >>> 0) != null;
                }
                catch (e){
                    void e;
                }
                if (!known)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const owner = (requested & OWNER_SECURITY_INFORMATION) !== 0
                    ? sidBytes(DEFAULT_OWNER) : null;
                const group = (requested & GROUP_SECURITY_INFORMATION) !== 0
                    ? sidBytes(PRIMARY_GROUP) : null;
                /** @type {Uint8Array | null} */
                let dacl = null;
                if ((requested & DACL_SECURITY_INFORMATION) !== 0)
                {
                    const aces = [GROUP_SIDS[2], SYSTEM_SID].map(sid=>{
                        const bytes = sidBytes(sid);
                        const ace = new Uint8Array(8 + bytes.length);
                        ace[0] = ACCESS_ALLOWED_ACE_TYPE;
                        ace[2] = ace.length;
                        new DataView(ace.buffer).setUint32(4, ALL_RIGHTS, true);
                        ace.set(bytes, 8);
                        return ace;
                    });
                    const acesSize = aces.reduce((sum, ace)=>sum + ace.length, 0);
                    dacl = new Uint8Array(ACL.HEADER + acesSize);
                    dacl[ACL.REVISION] = 2;
                    new DataView(dacl.buffer).setUint16(ACL.SIZE, dacl.length, true);
                    new DataView(dacl.buffer).setUint16(ACL.COUNT, aces.length, true);
                    let at = ACL.HEADER;
                    for (const ace of aces)
                    {
                        dacl.set(ace, at);
                        at += ace.length;
                    }
                }
                const parts = [owner, group, dacl];
                const size = SD.SIZE + parts.reduce((sum, part)=>sum + (part?.length ?? 0), 0);
                if ((needed >>> 0) !== 0)
                {
                    writeDword(needed >>> 0, size);
                }
                if ((length >>> 0) < size || (descriptor >>> 0) === 0)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                const bytes = new Uint8Array(size);
                const view = new DataView(bytes.buffer);
                bytes[SD.REVISION] = SECURITY_DESCRIPTOR_REVISION;
                view.setUint16(SD.CONTROL, SE_SELF_RELATIVE | (dacl ? SE_DACL_PRESENT : 0), true);
                let at = SD.SIZE;
                // The owner, the group and the DACL follow the header, each
                // named by its offset from the start; one not asked for is 0.
                [[SD.OWNER, owner], [SD.GROUP, group], [SD.DACL, dacl]].forEach(([slot, part])=>{
                    if (part)
                    {
                        view.setUint32(/** @type {number} */ (slot), at, true);
                        bytes.set(/** @type {Uint8Array} */ (part), at);
                        at += /** @type {Uint8Array} */ (part).length;
                    }
                });
                host.writeMemory(descriptor >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL SetKernelObjectSecurity(HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR)
         *
         * As SetSecurityInfo: accepted, with nobody else for it to matter to.
         */
        SetKernelObjectSecurity: {
            argBytes: 12,
            handler: ()=>1,
        },

        /**
         * BOOL AccessCheck(PSECURITY_DESCRIPTOR, HANDLE ClientToken, DWORD DesiredAccess,
         *   PGENERIC_MAPPING, PPRIVILEGE_SET, LPDWORD PrivilegeSetLength,
         *   LPDWORD GrantedAccess, LPBOOL AccessStatus)
         *
         * The DACL read ACE by ACE against the one account's SIDs: an
         * allowed ACE for a SID the token holds grants its rights, a denied
         * one takes them away. No DACL, or a null one, grants everything.
         * The check itself succeeds either way; whether access was granted is
         * the status, and a refusal says ERROR_ACCESS_DENIED. Windows wants an
         * impersonation token here; the one account's primary token is taken
         * as well, since there is nothing it could be told apart from.
         */
        AccessCheck: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([descriptor, token, desired, mapping, privileges, privilegesLength,
                granted, status])=>{
                if (!isToken(token))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const at = descriptorAt(descriptor);
                if (at === null)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                if ((mapping >>> 0) === 0 || (granted >>> 0) === 0 || (status >>> 0) === 0
                    || (privilegesLength >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (readDword(privilegesLength) < PRIVILEGE_SET_EMPTY)
                {
                    writeDword(privilegesLength >>> 0, PRIVILEGE_SET_EMPTY);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                if ((privileges >>> 0) !== 0)
                {
                    host.writeMemory(privileges >>> 0, new Uint8Array(PRIVILEGE_SET_EMPTY));
                }
                const map = [0, 4, 8, 12].map(offset=>readDword((mapping >>> 0) + offset));
                const wanted = mapGeneric(desired >>> 0, map);
                const control = readWord(at + SD.CONTROL);
                const dacl = readDword(at + SD.DACL);
                let allowed = 0;
                let denied = 0;
                if ((control & SE_DACL_PRESENT) === 0 || dacl === 0)
                {
                    allowed = 0xffffffff;
                }
                else
                {
                    const aces = acesOf(dacl);
                    if (aces === null)
                    {
                        return fail(ERROR_INVALID_ACL);
                    }
                    for (const ace of aces)
                    {
                        if (ace.sid === null || !isTokenMember(ace.sid))
                        {
                            continue;
                        }
                        // What an ACE already allowed stays allowed, as the
                        // DACL is read in order and the first word on a right
                        // decides it.
                        const rights = mapGeneric(ace.mask, map);
                        if (ace.type === ACCESS_ALLOWED_ACE_TYPE)
                        {
                            allowed |= rights & ~denied;
                        }
                        else
                        {
                            denied |= rights & ~allowed;
                        }
                    }
                }
                const asked = (wanted & MAXIMUM_ALLOWED) !== 0
                    ? (wanted & ~MAXIMUM_ALLOWED) : wanted;
                const ok = (asked & ~allowed) === 0 && (wanted === MAXIMUM_ALLOWED
                    ? allowed !== 0 : true);
                const answer = (wanted & MAXIMUM_ALLOWED) !== 0 ? allowed >>> 0 : asked;
                writeDword(granted >>> 0, ok ? answer : 0);
                writeDword(status >>> 0, ok ? 1 : 0);
                if (!ok)
                {
                    host.setLastError(ERROR_ACCESS_DENIED);
                }
                return 1;
            },
        },

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
                const code = openProcessToken(process, out);
                return code === ERROR_SUCCESS ? 1 : fail(code);
            },
        },

        /**
         * BOOL DuplicateToken(HANDLE ExistingTokenHandle,
         *     SECURITY_IMPERSONATION_LEVEL ImpersonationLevel, PHANDLE DuplicateTokenHandle)
         *
         * A second handle onto the same token, with the impersonation level the
         * caller asked for carried on it. There is one account, so the duplicate
         * names the same process; the level is recorded but nothing checks it.
         */
        DuplicateToken: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([existing, level, out])=>{
                const token = isToken(existing)
                    ? host.handles.resolve(existing >>> 0, 'token')
                    : null;
                if (!token)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, host.handles.open('token', {
                    process: token.process,
                    impersonationLevel: level >>> 0,
                }));
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
                const answer = information(tokenClass,
                    host.handles.resolve(token >>> 0, 'token'));
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
                const { slot = 0, stride = 0 } = answer;
                let at = answer.fixed.length;
                for (let index = 0; index < answer.sids.length; index++)
                {
                    whole.set(answer.sids[index], at);
                    new DataView(whole.buffer).setUint32(
                        slot + index * stride, (buffer >>> 0) + at, true);
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
                const code = adjustPrivileges(token, newState, previous, returnLength);
                if (code !== ERROR_SUCCESS)
                {
                    return fail(code);
                }
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * BOOL ConvertSidToStringSidA(PSID Sid, LPSTR *StringSid)
         * BOOL ConvertSidToStringSidW(PSID Sid, LPWSTR *StringSid)
         *
         * "S-1-<authority>-<sub>..." in a LocalAlloc block the caller frees
         * with LocalFree; an authority past 32 bits is written in hex.
         */
        ConvertSidToStringSidA: convertSid(false),
        ConvertSidToStringSidW: convertSid(true),

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

/** The account's SID as text, as ConvertSidToStringSid spells it. */
export const USER_SID_TEXT = `S-1-${USER_SID.authority}-${USER_SID.subAuthorities.join('-')}`;

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
