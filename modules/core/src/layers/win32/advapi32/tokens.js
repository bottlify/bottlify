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
 * the program compares one it built against one it read, byte for byte. ACEs,
 * ACLs and self-relative descriptors are laid out here too, once, for every
 * call that hands one out.
 */

import { COMPUTER_NAME } from '../kernel32/drives.js';
import { createDescriptorCodec } from './descriptors.js';

/**
 * Who the program is running as. There is one account and no way to become
 * another, so this is a constant rather than something to configure -- but it
 * has to be answered, because a program that cannot learn its own user name
 * often refuses to start rather than carrying on without one.
 */
export const USER_NAME = 'User';

/** The native calls' table, published by ntdll beside its own. */
export const TOKEN_NATIVES = Symbol('tokenNatives');

/**
 * The hook a kernel-object creator (CreateEvent, CreateMutex, …) calls to
 * keep the SECURITY_ATTRIBUTES' descriptor it was given, so that
 * GetKernelObjectSecurity hands it back -- a mandatory label among it.
 */
export const RECORD_OBJECT_SECURITY = Symbol('recordObjectSecurity');

/** Statuses the native calls answer. */
const STATUS_SUCCESS = 0;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_ACCESS_DENIED = 0xc0000022;

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
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_NONE_MAPPED = 1332;
const ERROR_BAD_TOKEN_TYPE = 1349;
const ERROR_NOACCESS = 998;
const SE_PRIVILEGE_USED_FOR_ACCESS = 0x80000000;
/** A machine named other than this one: there is no network to reach it over. */
const RPC_S_SERVER_UNAVAILABLE = 1722;

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
const SE_SACL_PRESENT = 0x0010;
const SE_SACL_DEFAULTED = 0x0020;
const SE_SELF_RELATIVE = 0x8000;

/** An ACL's header: revision, a pad, its size, its ACE count, a pad. */
const ACL = Object.freeze({ REVISION: 0, SIZE: 2, COUNT: 4, HEADER: 8 });
/** The revisions an ACL may be made with: ACL_REVISION and ACL_REVISION_DS. */
const ACL_REVISIONS = new Set([2, 3, 4]);
const ACL_REVISION = 2;
/**
 * An ACE: type, flags, size, then the mask and, for the four kinds that name
 * one trustee -- allowed, denied, audit, alarm -- its SID.
 */
const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACCESS_DENIED_ACE_TYPE = 1;
const SYSTEM_AUDIT_ACE_TYPE = 2;
const SYSTEM_ALARM_ACE_TYPE = 3;
const ACCESS_DENIED_OBJECT_ACE_TYPE = 6;
const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;
/** SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, NO_READ_UP and NO_EXECUTE_UP. */
const MANDATORY_POLICIES = 0x7;
/** The one of those a process token's own integrity label carries. */
const MANDATORY_LABEL_NO_WRITE_UP = 0x1;
/** An ACE's flags: how it is inherited, and whether it was. */
const INHERITANCE_FLAGS = 0x0f;
const INHERITED_ACE = 0x10;
const SUCCESSFUL_ACCESS_ACE_FLAG = 0x40;
const FAILED_ACCESS_ACE_FLAG = 0x80;

/**
 * EXPLICIT_ACCESS, the same in either form: the rights, the ACCESS_MODE, the
 * inheritance, then a TRUSTEE -- the multiple trustee and its operation, the
 * form, the type, and the name or SID the form says.
 */
const EXPLICIT_ACCESS = Object.freeze({ PERMISSIONS: 0, MODE: 4, INHERITANCE: 8,
    MULTIPLE_OPERATION: 16, FORM: 20, NAME: 28, SIZE: 32 });
const NOT_USED_ACCESS = 0;
const GRANT_ACCESS = 1;
const SET_ACCESS = 2;
const DENY_ACCESS = 3;
const REVOKE_ACCESS = 4;
const SET_AUDIT_SUCCESS = 5;
const SET_AUDIT_FAILURE = 6;
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_NAME = 1;
const NO_MULTIPLE_TRUSTEE = 0;
/** The name a trustee gives for whoever runs the program. */
const CURRENT_USER = 'CURRENT_USER';
/** Longer than any account or machine name a program could mean. */
const MAX_ACCOUNT_NAME = 256;

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
export const PRIVILEGES = new Map([
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
/** The same, by the name folded: Windows finds a privilege whatever its case. */
const PRIVILEGES_FOLDED = new Map([...PRIVILEGES]
    .map(([name, value])=>[name.toLowerCase(), value]));

/** The longest privilege name read out of the guest. */
const MAX_PRIVILEGE_NAME = 64;

/** TOKEN_INFORMATION_CLASS values this build answers. */
const TokenUser = 1;
const TokenGroups = 2;
const TokenOwner = 4;
const TokenPrimaryGroup = 5;
const TokenType = 8;
const TokenSessionId = 12;
const TokenPrivileges = 3;
const TokenDefaultDacl = 6;
const TokenImpersonationLevel = 9;
const TokenStatistics = 10;
const TokenElevationType = 18;
const TokenLinkedToken = 19;
const TokenElevation = 20;
const TokenIntegrityLevel = 25;
const TokenLogonSid = 28;
const TokenIsAppContainer = 29;

/** TOKEN_ELEVATION_TYPE: an account with no split token, as with UAC off. */
const TokenElevationTypeDefault = 1;
const ERROR_NO_SUCH_LOGON_SESSION = 1312;
const ERROR_BAD_LENGTH = 24;

/** SE_PRIVILEGE_ENABLED_BY_DEFAULT | SE_PRIVILEGE_ENABLED. */
const PRIVILEGE_ON = 0x3;
/**
 * The privileges an administrator's token holds, and which of them are on
 * from the start: change-notify, as on every token, and the ones an
 * elevated administrator has enabled -- impersonate and create-global.
 */
const HELD_PRIVILEGES = [
    'SeIncreaseQuotaPrivilege', 'SeSecurityPrivilege', 'SeTakeOwnershipPrivilege',
    'SeLoadDriverPrivilege', 'SeSystemProfilePrivilege', 'SeSystemtimePrivilege',
    'SeProfileSingleProcessPrivilege', 'SeIncreaseBasePriorityPrivilege',
    'SeCreatePagefilePrivilege', 'SeBackupPrivilege', 'SeRestorePrivilege',
    'SeShutdownPrivilege', 'SeDebugPrivilege', 'SeSystemEnvironmentPrivilege',
    'SeChangeNotifyPrivilege', 'SeRemoteShutdownPrivilege', 'SeUndockPrivilege',
    'SeManageVolumePrivilege', 'SeImpersonatePrivilege', 'SeCreateGlobalPrivilege',
];
const PRIVILEGES_ON = new Set(['SeChangeNotifyPrivilege', 'SeImpersonatePrivilege',
    'SeCreateGlobalPrivilege']);

/** S-1-16-12288: the high integrity level an elevated administrator runs at. */
const HIGH_INTEGRITY = { authority: 16, subAuthorities: [0x3000] };
/** SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED. */
const INTEGRITY_ATTRIBUTES = 0x60;
/**
 * S-1-5-5-0-<n>: the logon session's SID, which every token of the session
 * holds as a group marked SE_GROUP_LOGON_ID.
 */
const LOGON_SID = { authority: 5, subAuthorities: [5, 0, 0x3e7a1] };
const LOGON_ATTRIBUTES = 0xc0000007;

/** TOKEN_TYPE: a process's own token, and one made to impersonate with. */
const TOKEN_PRIMARY = 1;
const TOKEN_IMPERSONATION = 2;

/** SECURITY_IMPERSONATION_LEVEL: what ImpersonateLoggedOnUser impersonates at. */
const SECURITY_IMPERSONATION = 2;

/**
 * TokenOwner, TokenPrimaryGroup, TokenDefaultDacl, TokenSessionId,
 * TokenIntegrityLevel and the rest SetTokenInformation documents as settable.
 */
const SETTABLE_TOKEN_CLASSES = new Set([4, 5, 6, 12, 18, 24, 25, 26]);

/** SID_AND_ATTRIBUTES: a pointer and a DWORD. */
const SID_AND_ATTRIBUTES_SIZE = 8;

/** SE_GROUP_MANDATORY | SE_GROUP_ENABLED_BY_DEFAULT | SE_GROUP_ENABLED. */
const GROUP_ATTRIBUTES = 0x00000007;

/** The pseudo-handle GetCurrentProcess hands out. */
const CURRENT_PROCESS = 0xffffffff;
/** The pseudo-handle GetCurrentThread answers. */
const CURRENT_THREAD = 0xfffffffe;

/**
 * A SID as its authority and sub-authorities: S-1-<authority>-<sub>...
 *
 * @typedef {Object} Sid
 * @property {number} authority
 * @property {number[]} subAuthorities
 */

/** S-1-5-21-<three>: this machine, whose local accounts' SIDs all begin so. */
const MACHINE_DOMAIN = [21, 0x1a2b3c4d, 0x2b3c4d5e, 0x3c4d5e6f];

/** S-1-5-21-<three>-<rid>: a local account of this machine. */
const USER_SID = { authority: 5, subAuthorities: [...MACHINE_DOMAIN, 1000] };

/**
 * The groups every interactive administrator is in, in the order Windows
 * lists them: the domain's users, Everyone, BUILTIN\Administrators,
 * BUILTIN\Users, INTERACTIVE, Authenticated Users.
 *
 * @type {Sid[]}
 */
const GROUP_SIDS = [
    { authority: 5, subAuthorities: [...MACHINE_DOMAIN, 513] },
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

/** The SIDs another library describes an object's security with. */
export const WELL_KNOWN_SIDS = Object.freeze({
    everyone: GROUP_SIDS[1],
    administrators: GROUP_SIDS[2],
    users: GROUP_SIDS[3],
    system: SYSTEM_SID,
});

/** SECURITY_INFORMATION bits GetKernelObjectSecurity is asked for. */
const OWNER_SECURITY_INFORMATION = 0x1;
const GROUP_SECURITY_INFORMATION = 0x2;
const DACL_SECURITY_INFORMATION = 0x4;
const SACL_SECURITY_INFORMATION = 0x8;
const LABEL_SECURITY_INFORMATION = 0x10;
/** SE_OBJECT_TYPE of a service, whose security is the service manager's. */
const SE_SERVICE = 2;
/** Every standard and specific right: what GENERIC_ALL comes to on any object. */
const ALL_RIGHTS = 0x001fffff;

/** @param {Sid} sid @returns {Uint8Array} the SID, laid out */
export const sidBytes = sid=>{
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
 * A SID's text, as ConvertSidToStringSid writes it.
 *
 * @param {Uint8Array} sid
 */
export const sidText = sid=>{
    const view = new DataView(sid.buffer, sid.byteOffset, sid.length);
    const authority = view.getUint16(2) * 2 ** 32 + view.getUint32(4);
    let text = `S-1-${authority >= 2 ** 32 ? `0x${authority.toString(16)}` : authority}`;
    for (let at = 0; at < sid[1]; at++)
    {
        text += `-${view.getUint32(8 + at * 4, true)}`;
    }
    return text;
};

/**
 * The two-letter names SDDL gives the well-known SIDs, as ConvertStringSidToSid
 * reads them; the domain's own are this machine's.
 *
 * @type {Record<string, Sid>}
 */
export const SDDL_SIDS = {
    WD: { authority: 1, subAuthorities: [0] },
    CO: { authority: 3, subAuthorities: [0] },
    CG: { authority: 3, subAuthorities: [1] },
    OW: { authority: 3, subAuthorities: [4] },
    NU: { authority: 5, subAuthorities: [2] },
    IU: { authority: 5, subAuthorities: [4] },
    SU: { authority: 5, subAuthorities: [6] },
    AN: { authority: 5, subAuthorities: [7] },
    ED: { authority: 5, subAuthorities: [9] },
    PS: { authority: 5, subAuthorities: [10] },
    AU: { authority: 5, subAuthorities: [11] },
    RC: { authority: 5, subAuthorities: [12] },
    SY: { authority: 5, subAuthorities: [18] },
    LS: { authority: 5, subAuthorities: [19] },
    NS: { authority: 5, subAuthorities: [20] },
    BA: { authority: 5, subAuthorities: [32, 544] },
    BU: { authority: 5, subAuthorities: [32, 545] },
    BG: { authority: 5, subAuthorities: [32, 546] },
    PU: { authority: 5, subAuthorities: [32, 547] },
    AO: { authority: 5, subAuthorities: [32, 548] },
    SO: { authority: 5, subAuthorities: [32, 549] },
    PO: { authority: 5, subAuthorities: [32, 550] },
    BO: { authority: 5, subAuthorities: [32, 551] },
    RE: { authority: 5, subAuthorities: [32, 552] },
    RU: { authority: 5, subAuthorities: [32, 554] },
    RD: { authority: 5, subAuthorities: [32, 555] },
    NO: { authority: 5, subAuthorities: [32, 556] },
    LA: { authority: 5, subAuthorities: [...MACHINE_DOMAIN, 500] },
    LG: { authority: 5, subAuthorities: [...MACHINE_DOMAIN, 501] },
    AC: { authority: 15, subAuthorities: [2, 1] },
    LW: { authority: 16, subAuthorities: [0x1000] },
    ME: { authority: 16, subAuthorities: [0x2000] },
    HI: { authority: 16, subAuthorities: [0x3000] },
    SI: { authority: 16, subAuthorities: [0x4000] },
};

/**
 * A SID's text -- "S-1-<authority>-<sub>...", the authority decimal or 0x
 * hex, up to fifteen sub-authorities, or an SDDL name -- laid out, or null
 * for text that is not one.
 *
 * @param {string} text @returns {Uint8Array | null}
 */
export const parseSid = text=>{
    const named = SDDL_SIDS[text.toUpperCase()];
    if (named)
    {
        return sidBytes(named);
    }
    // Every number may be written in hex; a SID with no sub-authority is not
    // one ConvertStringSidToSid makes, though S-1-5 is a well-known one.
    const parts = /^S-(0x0*1|0*1)-(0x[0-9a-f]{1,12}|\d{1,15})((?:-(?:0x[0-9a-f]{1,8}|\d{1,10})){1,15})$/i
        .exec(text);
    if (!parts)
    {
        return null;
    }
    const authority = Number(parts[2].toLowerCase());
    const subs = parts[3].slice(1).split('-').map(sub=>Number(sub.toLowerCase()));
    if (authority >= 2 ** 48 || subs.some(sub=>sub > 0xffffffff))
    {
        return null;
    }
    const bytes = new Uint8Array(8 + 4 * subs.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = 1;
    bytes[1] = subs.length;
    view.setUint16(2, Math.floor(authority / 2 ** 32));
    view.setUint32(4, authority % 2 ** 32);
    subs.forEach((sub, at)=>view.setUint32(8 + at * 4, sub, true));
    return bytes;
};

/** @param {Uint8Array} left @param {Uint8Array} right */
const sameBytes = (left, right)=>left.length === right.length
    && left.every((byte, at)=>byte === right[at]);

/**
 * An ACE naming one trustee -- allowed, denied, audit or alarm -- laid out:
 * its header, the mask, the SID.
 *
 * @param {number} type @param {number} flags @param {number} mask @param {Uint8Array} sid
 */
export const aceBytes = (type, flags, mask, sid)=>{
    const ace = new Uint8Array(8 + sid.length);
    const view = new DataView(ace.buffer);
    ace[0] = type;
    ace[1] = flags;
    view.setUint16(2, ace.length, true);
    view.setUint32(4, mask >>> 0, true);
    ace.set(sid, 8);
    return ace;
};

/**
 * An ACL holding exactly the ACEs given, in their order.
 *
 * @param {Uint8Array[]} aces @param {number} [revision]
 */
export const aclBytes = (aces, revision = ACL_REVISION)=>{
    const acl = new Uint8Array(ACL.HEADER + aces.reduce((sum, ace)=>sum + ace.length, 0));
    const view = new DataView(acl.buffer);
    acl[ACL.REVISION] = revision;
    view.setUint16(ACL.SIZE, acl.length, true);
    view.setUint16(ACL.COUNT, aces.length, true);
    let at = ACL.HEADER;
    for (const ace of aces)
    {
        acl.set(ace, at);
        at += ace.length;
    }
    return acl;
};

/**
 * A self-relative SECURITY_DESCRIPTOR: the header, then each part it holds,
 * named by its offset from the start. A DACL or SACL given as null is present
 * but null -- the null DACL, which grants everyone everything; one not given
 * at all is absent. Where each part landed comes back beside the bytes, zero
 * for a part that is not there, for a caller that hands out pointers into it.
 *
 * @param {{ owner?: Uint8Array, group?: Uint8Array, dacl?: Uint8Array | null,
 *           sacl?: Uint8Array | null }} parts
 */
export const selfRelativeDescriptor = parts=>{
    const order = /** @type {const} */ (['owner', 'group', 'sacl', 'dacl']);
    const size = SD.SIZE + order.reduce((sum, name)=>sum + (parts[name]?.length ?? 0), 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    const offsets = { owner: 0, group: 0, sacl: 0, dacl: 0 };
    bytes[SD.REVISION] = SECURITY_DESCRIPTOR_REVISION;
    view.setUint16(SD.CONTROL, SE_SELF_RELATIVE | ('dacl' in parts ? SE_DACL_PRESENT : 0)
        | ('sacl' in parts ? SE_SACL_PRESENT : 0), true);
    const slots = { owner: SD.OWNER, group: SD.GROUP, sacl: SD.SACL, dacl: SD.DACL };
    let at = SD.SIZE;
    for (const name of order)
    {
        const part = parts[name];
        if (part)
        {
            view.setUint32(slots[name], at, true);
            bytes.set(part, at);
            offsets[name] = at;
            at += part.length;
        }
    }
    return { bytes, offsets };
};

/** The access rights SDDL names with two letters. */
export const SDDL_RIGHTS = Object.freeze({
    GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
    RC: 0x00020000, SD: 0x00010000, WD: 0x00040000, WO: 0x00080000,
    RP: 0x10, WP: 0x20, CC: 0x01, DC: 0x02, LC: 0x04, SW: 0x08, LO: 0x80, DT: 0x40, CR: 0x100,
    FA: 0x001f01ff, FR: 0x00120089, FW: 0x00120116, FX: 0x001200a0,
    KA: 0x000f003f, KR: 0x00020019, KW: 0x00020006, KX: 0x00020019,
});
/** The ACE flags SDDL names: inheritance, and the audit outcomes. */
export const SDDL_ACE_FLAGS = Object.freeze({
    OI: 0x01, CI: 0x02, NP: 0x04, IO: 0x08, ID: INHERITED_ACE,
    SA: SUCCESSFUL_ACCESS_ACE_FLAG, FA: FAILED_ACCESS_ACE_FLAG,
});
/** The ACE types SDDL names that this builds: the ones naming one trustee. */
export const SDDL_ACE_TYPES = Object.freeze({
    A: ACCESS_ALLOWED_ACE_TYPE, D: ACCESS_DENIED_ACE_TYPE, AU: SYSTEM_AUDIT_ACE_TYPE,
    AL: SYSTEM_ALARM_ACE_TYPE,
});
const SE_DACL_PROTECTED = 0x1000;
const SE_SACL_PROTECTED = 0x2000;
const SE_DACL_AUTO_INHERITED = 0x0400;
const SE_SACL_AUTO_INHERITED = 0x0800;

/**
 * Two-letter names run together, as SDDL writes rights and flags: every pair
 * has to be one the table knows.
 *
 * @param {string} text @param {Readonly<Record<string, number>>} table
 * @returns {number | null}
 */
const sddlBits = (text, table)=>{
    if (/^0x[0-9a-f]{1,8}$/i.test(text))
    {
        return Number(text) >>> 0;
    }
    if (text.length % 2 !== 0)
    {
        return null;
    }
    let bits = 0;
    for (let at = 0; at < text.length; at += 2)
    {
        const bit = table[/** @type {keyof typeof table} */ (text.slice(at, at + 2).toUpperCase())];
        if (bit === undefined)
        {
            return null;
        }
        bits = (bits | bit) >>> 0;
    }
    return bits;
};

/**
 * An ACL's part of an SDDL string -- its flags, then its ACEs in brackets --
 * as the control bits it sets and the ACL, null for `NO_ACCESS_CONTROL` (the
 * null ACL); undefined for text that is not one. An ACE naming an object type
 * is refused: the object ACEs are a directory service's.
 *
 * @param {string} text @param {'dacl' | 'sacl'} which
 * @returns {{ control: number, acl: Uint8Array | null } | undefined}
 */
const sddlAcl = (text, which)=>{
    const head = /^([A-Z_]*)((?:\([^)]*\))*)$/i.exec(text);
    if (!head)
    {
        return undefined;
    }
    const flags = head[1].toUpperCase();
    let control = 0;
    let rest = flags;
    if (rest.includes('NO_ACCESS_CONTROL'))
    {
        rest = rest.replace('NO_ACCESS_CONTROL', '');
        if (head[2] === '' && rest === '')
        {
            return { control: 0, acl: null };
        }
    }
    for (const [name, bit] of /** @type {[string, number][]} */ ([
        ['AI', which === 'dacl' ? SE_DACL_AUTO_INHERITED : SE_SACL_AUTO_INHERITED],
        ['AR', 0],
        ['P', which === 'dacl' ? SE_DACL_PROTECTED : SE_SACL_PROTECTED]]))
    {
        if (rest.includes(name))
        {
            rest = rest.replace(name, '');
            control |= bit;
        }
    }
    if (rest !== '')
    {
        return undefined;
    }
    /** @type {Uint8Array[]} */
    const aces = [];
    for (const [, body] of head[2].matchAll(/\(([^)]*)\)/g))
    {
        const [type, aceFlags, rights, object, inherited, trustee, ...more] = body.split(';');
        const kind = SDDL_ACE_TYPES[/** @type {keyof typeof SDDL_ACE_TYPES} */ (type.toUpperCase())];
        const bits = sddlBits(aceFlags, SDDL_ACE_FLAGS);
        const mask = sddlBits(rights, SDDL_RIGHTS);
        const sid = parseSid(trustee ?? '');
        if (kind === undefined || bits === null || mask === null || !sid || more.length > 0
            || (object ?? '') !== '' || (inherited ?? '') !== '')
        {
            return undefined;
        }
        aces.push(aceBytes(kind, bits, mask, sid));
    }
    return { control, acl: aclBytes(aces) };
};

/**
 * A security descriptor's SDDL -- `O:` owner, `G:` group, `D:` DACL, `S:`
 * SACL, each optional -- as a self-relative descriptor's bytes, or null for
 * text that is not one.
 *
 * @param {string} text @returns {Uint8Array | null}
 */
export const parseSddl = text=>{
    /** @type {{ owner?: Uint8Array, group?: Uint8Array, dacl?: Uint8Array | null,
     *           sacl?: Uint8Array | null }} */
    const parts = {};
    let control = 0;
    const sections = text.trim().split(/(?=[OGDS]:)/);
    for (const section of sections)
    {
        const kind = section.slice(0, 2).toUpperCase();
        const body = section.slice(2);
        if (kind === 'O:' || kind === 'G:')
        {
            const sid = parseSid(body);
            if (!sid)
            {
                return null;
            }
            parts[kind === 'O:' ? 'owner' : 'group'] = sid;
        }
        else if (kind === 'D:' || kind === 'S:')
        {
            const acl = sddlAcl(body, kind === 'D:' ? 'dacl' : 'sacl');
            if (!acl)
            {
                return null;
            }
            parts[kind === 'D:' ? 'dacl' : 'sacl'] = acl.acl;
            control |= acl.control;
        }
        else if (section !== '')
        {
            return null;
        }
    }
    const { bytes } = selfRelativeDescriptor(parts);
    const view = new DataView(bytes.buffer);
    view.setUint16(SD.CONTROL, view.getUint16(SD.CONTROL, true) | control, true);
    return bytes;
};

/**
 * A string of the caller's in UTF-16, up to its terminator or the limit.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @param {number} pointer @param {number} limit  In characters.
 */
export const wideTextAt = (readMemory, pointer, limit)=>{
    let text = '';
    for (let at = 0; at < limit; at++)
    {
        const unit = readMemory((pointer >>> 0) + at * 2, 2);
        const code = unit[0] | unit[1] << 8;
        if (code === 0)
        {
            break;
        }
        text += String.fromCharCode(code);
    }
    return text;
};

/** @param {string} text @param {boolean} wide @returns {Uint8Array} with its terminator */
export const encodeText = (text, wide)=>{
    const unit = wide ? 2 : 1;
    const bytes = new Uint8Array((text.length + 1) * unit);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * unit] = text.charCodeAt(at) & 0xff;
        if (wide)
        {
            bytes[at * unit + 1] = text.charCodeAt(at) >>> 8;
        }
    }
    return bytes;
};

/**
 * Whether a system name names this machine: none, an empty one, or its own
 * name with or without the backslashes before it. Any other machine is one
 * there is no network to reach.
 *
 * @param {string | null} name
 */
export const isThisMachine = name=>name === null || name === ''
    || name.replace(/^\\\\/, '').toUpperCase() === COMPUTER_NAME.toUpperCase();

/** SID_NAME_USE: what kind of account a name is. */
const SidTypeUser = 1;
const SidTypeGroup = 2;
const SidTypeDomain = 3;
const SidTypeAlias = 4;
const SidTypeWellKnownGroup = 5;

/**
 * @typedef {Object} Account
 * @property {Sid} sid
 * @property {string} name
 * @property {string} domain  Empty for the groups no authority's name qualifies.
 * @property {number} use     SID_NAME_USE.
 */

/**
 * @param {number} authority @param {number[]} subAuthorities @param {string} name
 * @param {string} domain @param {number} use
 * @returns {Account}
 */
const account = (authority, subAuthorities, name, domain, use)=>
    ({ sid: { authority, subAuthorities }, name, domain, use });

/**
 * Every account this machine has a name for, as an English Windows XP names
 * them: the groups of the world and creator authorities with no domain, NT
 * AUTHORITY's well-known groups, the BUILTIN domain and its aliases, and this
 * machine's own domain -- its built-in Administrator and Guest, the "None"
 * group a workgroup machine's users are in, and the one account.
 */
const ACCOUNTS = [
    account(0, [0], 'NULL SID', '', SidTypeWellKnownGroup),
    account(1, [0], 'Everyone', '', SidTypeWellKnownGroup),
    account(2, [0], 'LOCAL', '', SidTypeWellKnownGroup),
    account(3, [0], 'CREATOR OWNER', '', SidTypeWellKnownGroup),
    account(3, [1], 'CREATOR GROUP', '', SidTypeWellKnownGroup),
    account(3, [2], 'CREATOR OWNER SERVER', '', SidTypeWellKnownGroup),
    account(3, [3], 'CREATOR GROUP SERVER', '', SidTypeWellKnownGroup),
    account(5, [1], 'DIALUP', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [2], 'NETWORK', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [3], 'BATCH', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [4], 'INTERACTIVE', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [6], 'SERVICE', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [7], 'ANONYMOUS LOGON', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [8], 'PROXY', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [9], 'ENTERPRISE DOMAIN CONTROLLERS', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [10], 'SELF', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [11], 'Authenticated Users', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [12], 'RESTRICTED', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [13], 'TERMINAL SERVER USER', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [14], 'REMOTE INTERACTIVE LOGON', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [18], 'SYSTEM', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [19], 'LOCAL SERVICE', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [20], 'NETWORK SERVICE', 'NT AUTHORITY', SidTypeWellKnownGroup),
    account(5, [32], 'BUILTIN', 'BUILTIN', SidTypeDomain),
    account(5, [32, 544], 'Administrators', 'BUILTIN', SidTypeAlias),
    account(5, [32, 545], 'Users', 'BUILTIN', SidTypeAlias),
    account(5, [32, 546], 'Guests', 'BUILTIN', SidTypeAlias),
    account(5, [32, 547], 'Power Users', 'BUILTIN', SidTypeAlias),
    account(5, [32, 551], 'Backup Operators', 'BUILTIN', SidTypeAlias),
    account(5, [32, 552], 'Replicator', 'BUILTIN', SidTypeAlias),
    account(5, [32, 555], 'Remote Desktop Users', 'BUILTIN', SidTypeAlias),
    account(5, [32, 556], 'Network Configuration Operators', 'BUILTIN', SidTypeAlias),
    account(5, MACHINE_DOMAIN, COMPUTER_NAME, COMPUTER_NAME, SidTypeDomain),
    account(5, [...MACHINE_DOMAIN, 500], 'Administrator', COMPUTER_NAME, SidTypeUser),
    account(5, [...MACHINE_DOMAIN, 501], 'Guest', COMPUTER_NAME, SidTypeUser),
    account(5, [...MACHINE_DOMAIN, 513], 'None', COMPUTER_NAME, SidTypeGroup),
    { sid: USER_SID, name: USER_NAME, domain: COMPUTER_NAME, use: SidTypeUser },
];

/**
 * Names Windows also accepts for NT AUTHORITY's service accounts: written
 * without the space, as a service's configuration writes them.
 */
const ACCOUNT_ALIASES = new Map([['LOCALSERVICE', 'LOCAL SERVICE'],
    ['NETWORKSERVICE', 'NETWORK SERVICE']]);

/** @param {Uint8Array} sid @returns {Account | null} the account a SID, laid out, is */
export const accountOfSid = sid=>ACCOUNTS.find(entry=>sameBytes(sidBytes(entry.sid), sid)) ?? null;

/**
 * The account a name names, alone or after its domain and a backslash, in
 * any case: how a program names a trustee.
 *
 * @param {string} written @returns {Account | null}
 */
export const accountNamed = written=>{
    const at = written.lastIndexOf('\\');
    const domain = at < 0 ? null : written.slice(0, at).toUpperCase();
    const typed = written.slice(at + 1).toUpperCase();
    const name = ACCOUNT_ALIASES.get(typed) ?? typed;
    return ACCOUNTS.find(entry=>entry.name.toUpperCase() === name
        && (domain === null || entry.domain.toUpperCase() === domain)) ?? null;
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
 * @property {(handle: number, wanted: number) => Uint8Array | null} [serviceSecurity]
 *           A service handle's descriptor, self-relative with the parts asked
 *           for, or null for a handle that is not one.
 * @property {() => any} [currentThread]
 *           The calling thread, whose impersonation token SetThreadToken and
 *           ImpersonateSelf set. Absent, every caller is one thread.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {TokenHost} host
 */
export function createTokenFunctions(host){
    /**
     * The token each thread impersonates with, by the thread: a thread with
     * none acts as the process, which is every thread until it is given one.
     *
     * @type {Map<any, any>}
     */
    const impersonating = new Map();

    /** Every caller, on a host that cannot say which thread is calling. */
    const CALLER = Symbol('caller');
    const callingThread = ()=>host.currentThread?.() ?? CALLER;

    /** The thread a handle names, or null. @param {number} handle */
    const threadNamed = handle=>{
        if ((handle >>> 0) === CURRENT_THREAD)
        {
            return callingThread();
        }
        try
        {
            return host.handles.resolve(handle >>> 0, 'thread') ?? null;
        }
        catch (e){
            void e;
            return null;
        }
    };

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
            const memory = encodeText(text, wide);
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
     * Each token's default DACL once SetTokenInformation has set it, by what
     * the token is of -- every handle onto a process's token is the one
     * token. Null is a DACL set to none.
     *
     * @type {Map<unknown, Uint8Array | null>}
     */
    const defaultDacls = new Map();

    /**
     * @param {any} token @returns {Uint8Array | null} the DACL objects made
     *   with it get: everything to the administrators and the system, until set
     */
    const defaultDaclOf = token=>{
        const key = token?.process ?? token;
        return defaultDacls.has(key) ? /** @type {Uint8Array | null} */ (defaultDacls.get(key))
            : aclBytes([GROUP_SIDS[2], SYSTEM_SID].map(sid=>
                aceBytes(ACCESS_ALLOWED_ACE_TYPE, 0, GENERIC_ALL, sidBytes(sid))));
    };

    /** The LUID TokenStatistics names each token by, given out on first ask. */
    const tokenIds = new WeakMap();
    let nextTokenId = 0x20000;
    /** @param {any} token */
    const tokenIdOf = token=>{
        if (token === null || typeof token !== 'object')
        {
            return 0;
        }
        if (!tokenIds.has(token))
        {
            tokenIds.set(token, nextTokenId++);
        }
        return tokenIds.get(token);
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
            case TokenPrivileges:
            {
                const fixed = new Uint8Array(4 + 12 * HELD_PRIVILEGES.length);
                const view = new DataView(fixed.buffer);
                view.setUint32(0, HELD_PRIVILEGES.length, true);
                HELD_PRIVILEGES.forEach((name, at)=>{
                    view.setUint32(4 + at * 12, PRIVILEGES.get(name) ?? 0, true);
                    view.setUint32(4 + at * 12 + 8, PRIVILEGES_ON.has(name) ? PRIVILEGE_ON : 0,
                        true);
                });
                return { fixed, sids: [] };
            }
            // TOKEN_DEFAULT_DACL: the pointer, and the ACL after it unless it is null.
            case TokenDefaultDacl:
            {
                const dacl = defaultDaclOf(token);
                return { fixed: new Uint8Array(4), sids: dacl === null ? [] : [dacl] };
            }
            case TokenImpersonationLevel:
                return token?.impersonationLevel === undefined ? null
                    : { fixed: dwordBytes(token.impersonationLevel), sids: [] };
            case TokenStatistics:
            {
                // TOKEN_STATISTICS: its id, the logon's, a never-expiring
                // time, the type and level, the charge, and the counts.
                const fixed = new Uint8Array(56);
                const view = new DataView(fixed.buffer);
                view.setUint32(0, tokenIdOf(token), true);
                view.setUint32(8, LOGON_SID.subAuthorities[2], true);
                view.setUint32(16, 0xffffffff, true);
                view.setUint32(20, 0x7fffffff, true);
                view.setUint32(24, token?.impersonationLevel === undefined
                    ? TOKEN_PRIMARY : TOKEN_IMPERSONATION, true);
                view.setUint32(28, token?.impersonationLevel ?? 0, true);
                view.setUint32(32, 1024, true);
                view.setUint32(36, 1024 - (defaultDaclOf(token)?.length ?? 0), true);
                view.setUint32(40, GROUP_SIDS.length + 1, true);
                view.setUint32(44, HELD_PRIVILEGES.length, true);
                view.setUint32(48, tokenIdOf(token), true);
                return { fixed, sids: [] };
            }
            case TokenElevationType:
                return { fixed: dwordBytes(TokenElevationTypeDefault), sids: [] };
            case TokenElevation:
                return { fixed: dwordBytes(1), sids: [] };
            case TokenIntegrityLevel:
            {
                const fixed = new Uint8Array(SID_AND_ATTRIBUTES_SIZE);
                new DataView(fixed.buffer).setUint32(4, INTEGRITY_ATTRIBUTES, true);
                return { fixed, sids: [sidBytes(HIGH_INTEGRITY)] };
            }
            case TokenLogonSid:
            {
                const fixed = new Uint8Array(4 + SID_AND_ATTRIBUTES_SIZE);
                const view = new DataView(fixed.buffer);
                view.setUint32(0, 1, true);
                view.setUint32(8, LOGON_ATTRIBUTES, true);
                return { fixed, sids: [sidBytes(LOGON_SID)], slot: 4,
                    stride: SID_AND_ATTRIBUTES_SIZE };
            }
            case TokenIsAppContainer:
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
     * Any descriptor a getter is handed: an absolute one, whose parts are
     * pointers, or a self-relative one -- what GetFileSecurity and
     * RegGetKeySecurity fill in -- whose parts are offsets from its start.
     * Null for anything else.
     *
     * @param {number} descriptor
     * @returns {{ at: number, control: number, part: (slot: number) => number } | null}
     */
    const anyDescriptor = descriptor=>{
        if ((descriptor >>> 0) === 0)
        {
            return null;
        }
        const at = descriptor >>> 0;
        if (host.readMemory(at, 1)[0] !== SECURITY_DESCRIPTOR_REVISION)
        {
            return null;
        }
        const control = readWord(at + SD.CONTROL);
        const relative = (control & SE_SELF_RELATIVE) !== 0;
        return {
            at, control,
            part: slot=>{
                const value = readDword(at + slot);
                return relative && value !== 0 ? (at + value) >>> 0 : value;
            },
        };
    };

    /** @param {number} acl  An ACL's size, from its header. */
    const aclLength = acl=>(acl === 0 ? 0 : readWord(acl + ACL.SIZE));

    /** @param {number} sid */
    const sidLength = sid=>(sid === 0 ? 0 : 8 + 4 * host.readMemory(sid, 2)[1]);

    /**
     * GetSecurityDescriptorOwner and Group: the SID's pointer, and whether
     * it was defaulted.
     *
     * @param {number} slot @param {number} bit
     */
    const getSidOf = (slot, bit)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [descriptor, out, defaulted])=>{
            const held = anyDescriptor(descriptor);
            if (held === null)
            {
                return fail(ERROR_INVALID_SECURITY_DESCR);
            }
            if ((out >>> 0) === 0 || (defaulted >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            writeDword(out >>> 0, held.part(slot));
            writeDword(defaulted >>> 0, (held.control & bit) !== 0 ? 1 : 0);
            return 1;
        },
    });

    /**
     * GetSecurityDescriptorDacl and Sacl: whether the list is present and,
     * when it is, its pointer -- null for the null list -- and whether it was
     * defaulted; an absent one leaves the other two as they were.
     *
     * @param {number} slot @param {number} presentBit @param {number} defaultedBit
     */
    const getAclOf = (slot, presentBit, defaultedBit)=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [descriptor, present, out, defaulted])=>{
            const held = anyDescriptor(descriptor);
            if (held === null)
            {
                return fail(ERROR_INVALID_SECURITY_DESCR);
            }
            if ((present >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const isPresent = (held.control & presentBit) !== 0;
            writeDword(present >>> 0, isPresent ? 1 : 0);
            if (isPresent)
            {
                if ((out >>> 0) !== 0)
                {
                    writeDword(out >>> 0, held.part(slot));
                }
                if ((defaulted >>> 0) !== 0)
                {
                    writeDword(defaulted >>> 0, (held.control & defaultedBit) !== 0 ? 1 : 0);
                }
            }
            return 1;
        },
    });

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
     * Each ACE of an ACL, walked by its sizes: where it starts and where the
     * next does, its type, flags and mask and, for an ACE naming one trustee,
     * its SID.
     *
     * @param {number} acl
     * @returns {{ type: number, flags: number, mask: number, sid: Uint8Array | null,
     *             at: number, next: number }[] | null}
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
            const flags = ace[1];
            const mask = readDword((acl >>> 0) + at + 4);
            const sid = type <= SYSTEM_ALARM_ACE_TYPE ? sidAt((acl >>> 0) + at + 8) : null;
            aces.push({ type, flags, mask, sid, at, next: at + aceSize });
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
    const addAce = (acl, type, mask, sid, flags = 0, revision = ACL_REVISION)=>{
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
        host.writeMemory((acl >>> 0) + at, aceBytes(type, flags & 0xff, mask, bytes));
        writeWord((acl >>> 0) + ACL.COUNT, aces.length + 1);
        raiseRevision(acl, revision);
        return 1;
    };

    /**
     * An ACL takes the highest revision any ACE added to it was added with:
     * an object ACE makes it a directory-service ACL. A revision past the
     * last is written as given, as Windows does, and leaves an ACL nothing
     * else accepts.
     *
     * @param {number} acl @param {number} revision
     */
    const raiseRevision = (acl, revision)=>{
        if ((revision >>> 0) > host.readMemory(acl >>> 0, 1)[0] && (revision >>> 0) <= 0xff)
        {
            host.writeMemory(acl >>> 0, new Uint8Array([revision >>> 0]));
        }
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
     * A string of the caller's, narrow or wide, or null for a NULL pointer.
     *
     * @param {number} pointer @param {boolean} wide @param {number} limit  In characters.
     */
    const textAt = (pointer, wide, limit)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        return wide ? wideTextAt(host.readMemory, pointer, limit)
            : host.readCString(pointer >>> 0, limit);
    };

    /** @param {boolean} wide */
    const convertText = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([text, out])=>{
            if ((text >>> 0) === 0 || (out >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const sid = parseSid(/** @type {string} */ (textAt(text, wide, 256)));
            if (!sid)
            {
                return fail(ERROR_INVALID_SID);
            }
            const block = host.allocate(sid.length);
            host.writeMemory(block, sid);
            writeDword(out >>> 0, block);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

    /** @param {boolean} wide */
    const convertDescriptor = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([text, revision, out, size])=>{
            if ((text >>> 0) === 0 || (out >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if ((revision >>> 0) !== 1)
            {
                return fail(ERROR_UNKNOWN_REVISION);
            }
            const descriptor = parseSddl(/** @type {string} */ (textAt(text, wide, 4096)));
            if (!descriptor)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const block = host.allocate(descriptor.length);
            host.writeMemory(block, descriptor);
            writeDword(out >>> 0, block);
            if ((size >>> 0) !== 0)
            {
                writeDword(size >>> 0, descriptor.length);
            }
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

    /** @param {boolean} wide */
    const lookupPrivilegeValue = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [system, name, out])=>{
            if (!isThisMachine(textAt(system, wide, MAX_ACCOUNT_NAME)))
            {
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            const wanted = textAt(name, wide, MAX_PRIVILEGE_NAME);
            const value = wanted === null ? undefined : PRIVILEGES_FOLDED.get(wanted.toLowerCase());
            if (value === undefined)
            {
                return fail(ERROR_NO_SUCH_PRIVILEGE);
            }
            if ((out >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            writeDword(out >>> 0, value);
            writeDword((out >>> 0) + 4, 0);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

    /**
     * BOOL LookupAccountSid(LPCTSTR lpSystemName, PSID Sid, LPTSTR Name,
     *   LPDWORD cchName, LPTSTR ReferencedDomainName, LPDWORD cchReferencedDomainName,
     *   PSID_NAME_USE peUse)
     *
     * Both names fit or neither is written: a size too small for its name and
     * terminator fails the call with ERROR_INSUFFICIENT_BUFFER and both sizes
     * set to what is needed, terminators counted; a fit writes the names
     * whose buffers were given and sets the sizes to their lengths, without.
     * Windows does not survive a NULL size or use; refused here instead.
     *
     * @param {boolean} wide
     */
    const lookupAccountSid = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [system, sid, name, nameSize, domain, domainSize,
            use])=>{
            if (!isThisMachine(textAt(system, wide, MAX_ACCOUNT_NAME)))
            {
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            if ((sid >>> 0) === 0 || (nameSize >>> 0) === 0 || (domainSize >>> 0) === 0
                || (use >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const bytes = sidAt(sid);
            if (bytes === null)
            {
                return fail(ERROR_INVALID_SID);
            }
            const found = accountOfSid(bytes);
            if (found === null)
            {
                return fail(ERROR_NONE_MAPPED);
            }
            if (readDword(nameSize) <= found.name.length
                || readDword(domainSize) <= found.domain.length)
            {
                writeDword(nameSize >>> 0, found.name.length + 1);
                writeDword(domainSize >>> 0, found.domain.length + 1);
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            if ((name >>> 0) !== 0)
            {
                host.writeMemory(name >>> 0, encodeText(found.name, wide));
            }
            if ((domain >>> 0) !== 0)
            {
                host.writeMemory(domain >>> 0, encodeText(found.domain, wide));
            }
            writeDword(nameSize >>> 0, found.name.length);
            writeDword(domainSize >>> 0, found.domain.length);
            writeDword(use >>> 0, found.use);
            return 1;
        },
    });

    /**
     * BOOL LookupAccountName(LPCTSTR lpSystemName, LPCTSTR lpAccountName, PSID Sid,
     *   LPDWORD cbSid, LPTSTR ReferencedDomainName, LPDWORD cchReferencedDomainName,
     *   PSID_NAME_USE peUse)
     *
     * The account a name names, alone or after its domain; the sizes work as
     * LookupAccountSid's do -- both fit or neither is written.
     *
     * @param {boolean} wide
     */
    const lookupAccountName = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [system, accountName, sid, sidSize, domain, domainSize,
            use])=>{
            if (!isThisMachine(textAt(system, wide, MAX_ACCOUNT_NAME)))
            {
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            const written = textAt(accountName, wide, MAX_ACCOUNT_NAME);
            if (written === null || (sidSize >>> 0) === 0 || (domainSize >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            // An empty name is the machine's own domain.
            const found = accountNamed(written === '' ? COMPUTER_NAME : written);
            if (found === null)
            {
                return fail(ERROR_NONE_MAPPED);
            }
            const bytes = sidBytes(found.sid);
            if (readDword(sidSize) < bytes.length || readDword(domainSize) <= found.domain.length
                || (sid >>> 0) === 0 || (domain >>> 0) === 0)
            {
                writeDword(sidSize >>> 0, bytes.length);
                writeDword(domainSize >>> 0, found.domain.length + 1);
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            host.writeMemory(sid >>> 0, bytes);
            host.writeMemory(domain >>> 0, encodeText(found.domain, wide));
            writeDword(sidSize >>> 0, bytes.length);
            writeDword(domainSize >>> 0, found.domain.length);
            if ((use >>> 0) !== 0)
            {
                writeDword(use >>> 0, found.use);
            }
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

    /** @param {number} handle @returns {any} the token a handle names, or null */
    const tokenNamed = handle=>(isToken(handle)
        ? host.handles.resolve(handle >>> 0, 'token') : null);

    /**
     * The SID an EXPLICIT_ACCESS's trustee names, laid out, or the error that
     * refuses it. A trustee named rather than given by SID may not be a
     * multiple one, which Windows' own tests see refused; the trustee forms
     * that carry directory-object types have no objects here to apply to.
     *
     * @param {number} entry @param {boolean} wide
     * @returns {Uint8Array | number}
     */
    const trusteeSid = (entry, wide)=>{
        const form = readDword(entry + EXPLICIT_ACCESS.FORM);
        const pointer = readDword(entry + EXPLICIT_ACCESS.NAME);
        if (form === TRUSTEE_IS_SID)
        {
            return sidAt(pointer) ?? ERROR_INVALID_SID;
        }
        if (form !== TRUSTEE_IS_NAME
            || readDword(entry + EXPLICIT_ACCESS.MULTIPLE_OPERATION) !== NO_MULTIPLE_TRUSTEE)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const written = textAt(pointer, wide, MAX_ACCOUNT_NAME);
        if (written === null)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if (written.toUpperCase() === CURRENT_USER)
        {
            return sidBytes(USER_SID);
        }
        const named = accountNamed(written);
        return named === null ? ERROR_NONE_MAPPED : sidBytes(named.sid);
    };

    /**
     * An ACE being merged: what it says, and -- for one carried over from the
     * old ACL unchanged -- its bytes as they were.
     *
     * @typedef {Object} MergedAce
     * @property {number} type
     * @property {number} flags
     * @property {number} mask
     * @property {Uint8Array | null} sid
     * @property {Uint8Array | null} bytes
     */

    /**
     * DWORD SetEntriesInAcl(ULONG cCountOfExplicitEntries,
     *   PEXPLICIT_ACCESS pListOfExplicitEntries, PACL OldAcl, PACL *NewAcl)
     *
     * A new ACL, in a LocalAlloc block, of the old one's ACEs with the
     * entries applied in order, as ACCESS_MODE documents each: a grant adds
     * its rights to the trustee's allowed ACE of the same inheritance, a deny
     * likewise to its denied one, a set replaces whatever the trustee was
     * allowed or denied, a revoke takes away what it was allowed and audited,
     * and the audit modes add to its audit ACE. The ACEs come out in the
     * order a DACL is read in: the explicitly denied, then the rest of the
     * explicit ones, then the inherited, untouched, in their old order. The
     * new pointer is NULL until the call succeeds, and stays NULL when there
     * was neither an entry nor an old ACL.
     *
     * @param {boolean} wide
     */
    const setEntriesInAcl = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [count, entries, old, out])=>{
            if ((out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            writeDword(out >>> 0, 0);
            const total = count >>> 0;
            if (total === 0 && (old >>> 0) === 0)
            {
                return ERROR_SUCCESS;
            }
            if (total !== 0 && (entries >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            let revision = ACL_REVISION;
            /** @type {MergedAce[]} */
            let explicit = [];
            /** @type {Uint8Array[]} */
            const inherited = [];
            if ((old >>> 0) !== 0)
            {
                const aces = acesOf(old);
                if (aces === null)
                {
                    return ERROR_INVALID_ACL;
                }
                revision = host.readMemory(old >>> 0, 1)[0];
                for (const ace of aces)
                {
                    const bytes = host.readMemory((old >>> 0) + ace.at, ace.next - ace.at).slice();
                    if ((ace.flags & INHERITED_ACE) !== 0)
                    {
                        inherited.push(bytes);
                    }
                    else
                    {
                        explicit.push({ type: ace.type, flags: ace.flags, mask: ace.mask,
                            sid: ace.sid, bytes });
                    }
                }
            }
            for (let index = 0; index < total; index++)
            {
                const entry = (entries >>> 0) + index * EXPLICIT_ACCESS.SIZE;
                const mode = readDword(entry + EXPLICIT_ACCESS.MODE);
                if (mode === NOT_USED_ACCESS)
                {
                    continue;
                }
                if (mode > SET_AUDIT_FAILURE)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const trustee = trusteeSid(entry, wide);
                if (typeof trustee === 'number')
                {
                    return trustee;
                }
                const mask = readDword(entry + EXPLICIT_ACCESS.PERMISSIONS);
                const flags = readDword(entry + EXPLICIT_ACCESS.INHERITANCE) & INHERITANCE_FLAGS;
                /** @param {MergedAce} ace */
                const names = ace=>ace.sid !== null && sameBytes(ace.sid, trustee);
                /** @param {number} type @param {number} aceFlags */
                const merge = (type, aceFlags)=>{
                    const held = explicit.find(ace=>ace.type === type && ace.flags === aceFlags
                        && names(ace));
                    if (held)
                    {
                        held.mask = (held.mask | mask) >>> 0;
                        held.bytes = null;
                    }
                    else
                    {
                        explicit.push({ type, flags: aceFlags, mask, sid: trustee, bytes: null });
                    }
                };
                switch (mode)
                {
                    case GRANT_ACCESS:
                        merge(ACCESS_ALLOWED_ACE_TYPE, flags);
                        break;
                    case DENY_ACCESS:
                        merge(ACCESS_DENIED_ACE_TYPE, flags);
                        break;
                    case SET_ACCESS:
                        explicit = explicit.filter(ace=>ace.type > ACCESS_DENIED_ACE_TYPE
                            || !names(ace));
                        merge(ACCESS_ALLOWED_ACE_TYPE, flags);
                        break;
                    case REVOKE_ACCESS:
                        explicit = explicit.filter(ace=>!names(ace)
                            || (ace.type !== ACCESS_ALLOWED_ACE_TYPE
                                && ace.type !== SYSTEM_AUDIT_ACE_TYPE));
                        break;
                    default:
                        merge(SYSTEM_AUDIT_ACE_TYPE, flags | (mode === SET_AUDIT_SUCCESS
                            ? SUCCESSFUL_ACCESS_ACE_FLAG : FAILED_ACCESS_ACE_FLAG));
                }
            }
            /** @param {MergedAce} ace */
            const denies = ace=>ace.type === ACCESS_DENIED_ACE_TYPE
                || ace.type === ACCESS_DENIED_OBJECT_ACE_TYPE;
            const laid = [...explicit.filter(denies), ...explicit.filter(ace=>!denies(ace))]
                .map(ace=>ace.bytes ?? aceBytes(ace.type, ace.flags, ace.mask,
                    /** @type {Uint8Array} */ (ace.sid)));
            const acl = aclBytes([...laid, ...inherited], revision);
            if (acl.length > 0xffff)
            {
                return ERROR_NOT_ENOUGH_MEMORY;
            }
            const block = host.allocate(acl.length);
            host.writeMemory(block, acl);
            writeDword(out >>> 0, block);
            return ERROR_SUCCESS;
        },
    });

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

    const codec = createDescriptorCodec(host.readMemory);

    /** The pseudo-handles a process has for itself and its thread, as objects of their own. */
    const PSEUDO_OBJECTS = new Map([[0xffffffff, { pseudo: 'process' }],
        [0xfffffffe, { pseudo: 'thread' }], [0xfffffffd, { pseudo: 'token' }]]);

    /** @param {number} handle @returns {object | null} the kernel object a handle names */
    const kernelObject = handle=>{
        const pseudo = PSEUDO_OBJECTS.get(handle >>> 0);
        if (pseudo)
        {
            return pseudo;
        }
        try
        {
            const object = host.handles.resolve(handle >>> 0);
            return object !== null && typeof object === 'object' ? object : null;
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * Each kernel object's descriptor once a program has set one, by the
     * object: every handle onto it sees the same.
     *
     * @type {WeakMap<object, import('./descriptors.js').DescriptorParts>}
     */
    const objectSecurity = new WeakMap();

    /** @returns {import('./descriptors.js').DescriptorParts} what an object starts with */
    const defaultParts = ()=>({
        control: SE_DACL_PRESENT,
        owner: sidBytes(DEFAULT_OWNER),
        group: sidBytes(PRIMARY_GROUP),
        dacl: aclBytes([GROUP_SIDS[2], SYSTEM_SID].map(sid=>
            aceBytes(ACCESS_ALLOWED_ACE_TYPE, 0, ALL_RIGHTS, sidBytes(sid)))),
    });

    /**
     * What a token starts with: an object's default parts and, besides, the
     * token's own integrity label as a SACL -- one mandatory-label ACE at the
     * level the token runs at, which GetKernelObjectSecurity(LABEL) hands
     * back. A program reads it to learn its own integrity before it tries
     * something a lower one may not.
     *
     * @returns {import('./descriptors.js').DescriptorParts}
     */
    const tokenDefaultParts = ()=>({
        ...defaultParts(),
        control: SE_DACL_PRESENT | SE_SACL_PRESENT,
        sacl: aclBytes([aceBytes(SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0,
            MANDATORY_LABEL_NO_WRITE_UP, sidBytes(HIGH_INTEGRITY))]),
    });

    /**
     * The parts a SECURITY_INFORMATION names, put over the object's.
     *
     * @param {object} object @param {import('./descriptors.js').DescriptorParts} parts
     * @param {number} wanted
     */
    const storeParts = (object, parts, wanted)=>{
        const held = { ...objectSecurity.get(object) ?? defaultParts() };
        if ((wanted & OWNER_SECURITY_INFORMATION) !== 0 && parts.owner)
        {
            held.owner = parts.owner;
        }
        if ((wanted & GROUP_SECURITY_INFORMATION) !== 0 && parts.group)
        {
            held.group = parts.group;
        }
        if ((wanted & DACL_SECURITY_INFORMATION) !== 0)
        {
            held.dacl = parts.dacl ?? null;
            held.control |= SE_DACL_PRESENT;
        }
        if ((wanted & SACL_SECURITY_INFORMATION) !== 0)
        {
            held.sacl = (parts.control & SE_SACL_PRESENT) !== 0 ? parts.sacl ?? null
                : aclBytes([]);
            held.control |= SE_SACL_PRESENT;
        }
        else if ((wanted & LABEL_SECURITY_INFORMATION) !== 0)
        {
            // A label is the SACL's mandatory-label ACEs alone: setting it
            // keeps those of the SACL given, in its revision, and none
            // given leaves an empty SACL behind.
            const given = (parts.control & SE_SACL_PRESENT) !== 0 ? parts.sacl ?? null : null;
            const aces = given === null ? [] : codec.acesIn(given) ?? [];
            held.sacl = aclBytes(aces.filter(ace=>ace.type === SYSTEM_MANDATORY_LABEL_ACE_TYPE)
                .map(ace=>ace.bytes), given?.[0] ?? ACL_REVISION);
            held.control |= SE_SACL_PRESENT;
        }
        objectSecurity.set(object, held);
    };

    /**
     * A kernel object's descriptor, self-relative, with the parts asked for;
     * null for a handle that names none. A label asked for alone is the
     * SACL's mandatory labels, an empty SACL when there are none set.
     *
     * @param {number} handle @param {number} wanted @returns {Uint8Array | null}
     */
    const kernelDescriptor = (handle, wanted)=>{
        const object = kernelObject(handle);
        if (object === null)
        {
            return null;
        }
        const parts = objectSecurity.get(object)
            ?? (isToken(handle) ? tokenDefaultParts() : defaultParts());
        const asked = codec.partsAskedFor(parts, wanted);
        return codec.selfRelative(asked);
    };

    /** @param {number} code @returns {number} the status a native call answers it with */
    const statusOf = code=>(code === ERROR_SUCCESS ? STATUS_SUCCESS
        : code === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE : STATUS_ACCESS_VIOLATION);

    /**
     * The access an object's DACL grants a token, as both AccessCheck (a
     * BOOL and win32 error) and NtAccessCheck (an NTSTATUS) need it: the two
     * differ only in how they write the verdict out, so the walk lives once.
     *
     * `code` is ERROR_SUCCESS when the check ran -- `ok` then says whether
     * access was granted and `granted` is the mask -- or the win32 error that
     * stopped it. The PRIVILEGE_SET buffer and its length are out-parameters
     * either form writes, so they are written here. The granted/status
     * pointers are not read: each caller validates and writes its own.
     *
     * @param {number} descriptor @param {number} token @param {number} desired
     * @param {number} mapping @param {number} privileges @param {number} privilegesLength
     * @returns {{ code: number, ok?: boolean, granted?: number }}
     */
    const evaluateAccess = (descriptor, token, desired, mapping, privileges, privilegesLength)=>{
        if (!isToken(token))
        {
            return { code: ERROR_INVALID_HANDLE };
        }
        // Either form: what GetKernelObjectSecurity hands back is
        // self-relative, and is checked as it comes.
        const held = anyDescriptor(descriptor);
        if (held === null)
        {
            return { code: ERROR_INVALID_SECURITY_DESCR };
        }
        if ((mapping >>> 0) === 0 || (privilegesLength >>> 0) === 0)
        {
            return { code: ERROR_INVALID_PARAMETER };
        }
        if (readDword(privilegesLength) < PRIVILEGE_SET_EMPTY)
        {
            writeDword(privilegesLength >>> 0, PRIVILEGE_SET_EMPTY);
            return { code: ERROR_INSUFFICIENT_BUFFER };
        }
        if ((privileges >>> 0) !== 0)
        {
            host.writeMemory(privileges >>> 0, new Uint8Array(PRIVILEGE_SET_EMPTY));
        }
        const map = [0, 4, 8, 12].map(offset=>readDword((mapping >>> 0) + offset));
        const wanted = mapGeneric(desired >>> 0, map);
        const control = held.control;
        const dacl = held.part(SD.DACL);
        let allowed = 0;
        let denied = 0;
        if ((control & SE_DACL_PRESENT) === 0 || dacl === 0)
        {
            // Everything the object's rights come to, and anything asked for
            // by name besides.
            allowed = (map[3] | wanted & ~MAXIMUM_ALLOWED) >>> 0;
        }
        else
        {
            const aces = acesOf(dacl);
            if (aces === null)
            {
                return { code: ERROR_INVALID_ACL };
            }
            for (const ace of aces)
            {
                // An audit or alarm ACE says what to record, not who is let in.
                if (ace.type > ACCESS_DENIED_ACE_TYPE || ace.sid === null
                    || !isTokenMember(ace.sid))
                {
                    continue;
                }
                // What an ACE already allowed stays allowed, as the DACL is
                // read in order and the first word on a right decides it.
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
        const asked = (wanted & MAXIMUM_ALLOWED) !== 0 ? (wanted & ~MAXIMUM_ALLOWED) : wanted;
        const ok = (asked & ~allowed) === 0 && (wanted === MAXIMUM_ALLOWED ? allowed !== 0 : true);
        const answer = (wanted & MAXIMUM_ALLOWED) !== 0 ? allowed >>> 0 : asked;
        return { code: ERROR_SUCCESS, ok, granted: ok ? answer : 0 };
    };

    /**
     * AccessCheck's body: the verdict written as a BOOL *AccessStatus and the
     * granted mask, 1 returned unless a parameter is wrong. A denied check is
     * still a successful call (1), with the last error set.
     *
     * @param {number} descriptor @param {number} token @param {number} desired
     * @param {number} mapping @param {number} privileges @param {number} privilegesLength
     * @param {number} granted @param {number} status
     */
    const accessCheck = (descriptor, token, desired, mapping, privileges, privilegesLength,
        granted, status)=>
    {
        if ((granted >>> 0) === 0 || (status >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const verdict = evaluateAccess(descriptor, token, desired, mapping, privileges,
            privilegesLength);
        if (verdict.code !== ERROR_SUCCESS)
        {
            return fail(verdict.code);
        }
        writeDword(granted >>> 0, verdict.granted ?? 0);
        writeDword(status >>> 0, verdict.ok ? 1 : 0);
        if (!verdict.ok)
        {
            host.setLastError(ERROR_ACCESS_DENIED);
        }
        return 1;
    };

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
        /**
         * A freshly created kernel object keeps the descriptor its
         * SECURITY_ATTRIBUTES carried: owner, group, DACL and SACL as the
         * descriptor marks each present. Absent or null, the object keeps
         * nothing and GetKernelObjectSecurity synthesises a default.
         *
         * @param {object} object @param {number} descriptor
         */
        [RECORD_OBJECT_SECURITY]: (object, descriptor)=>{
            const parts = codec.partsOf(descriptor);
            if (parts === null)
            {
                return;
            }
            const wanted = (parts.owner ? OWNER_SECURITY_INFORMATION : 0)
                | (parts.group ? GROUP_SECURITY_INFORMATION : 0)
                | ((parts.control & SE_DACL_PRESENT) !== 0 ? DACL_SECURITY_INFORMATION : 0)
                | ((parts.control & SE_SACL_PRESENT) !== 0 ? SACL_SECURITY_INFORMATION : 0);
            storeParts(object, parts, wanted);
        },

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

            /**
             * NTSTATUS NtSetSecurityObject(HANDLE, SECURITY_INFORMATION,
             *   PSECURITY_DESCRIPTOR) -- the handle's security kept, as
             *   SetKernelObjectSecurity keeps it.
             */
            NtSetSecurityObject: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([handle, wanted, descriptor])=>{
                    const object = kernelObject(handle);
                    const parts = codec.partsOf(descriptor);
                    if (object === null)
                    {
                        return STATUS_INVALID_HANDLE;
                    }
                    if (parts === null)
                    {
                        return STATUS_ACCESS_VIOLATION;
                    }
                    storeParts(object, parts, wanted >>> 0);
                    return STATUS_SUCCESS;
                },
            },

            /**
             * NTSTATUS NtQuerySecurityObject(HANDLE, SECURITY_INFORMATION,
             *   PSECURITY_DESCRIPTOR, ULONG Length, PULONG LengthNeeded)
             */
            NtQuerySecurityObject: {
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([handle, wanted, descriptor, length, needed])=>{
                    const bytes = kernelDescriptor(handle, wanted >>> 0);
                    if (bytes === null)
                    {
                        return STATUS_INVALID_HANDLE;
                    }
                    if ((needed >>> 0) !== 0)
                    {
                        writeDword(needed >>> 0, bytes.length);
                    }
                    if ((length >>> 0) < bytes.length)
                    {
                        return STATUS_BUFFER_TOO_SMALL;
                    }
                    host.writeMemory(descriptor >>> 0, bytes);
                    return STATUS_SUCCESS;
                },
            },

            /**
             * NTSTATUS NtAccessCheck(PSECURITY_DESCRIPTOR, HANDLE ClientToken,
             *   ACCESS_MASK DesiredAccess, PGENERIC_MAPPING, PPRIVILEGE_SET,
             *   PULONG ReturnLength, PACCESS_MASK GrantedAccess, PNTSTATUS AccessStatus)
             *
             * The same walk as AccessCheck, but the verdict is an NTSTATUS:
             * the call returns STATUS_SUCCESS when the check ran and writes
             * *AccessStatus as STATUS_SUCCESS or STATUS_ACCESS_DENIED, rather
             * than a BOOL with the last error set.
             */
            NtAccessCheck: {
                argBytes: 32,
                /** @param {number[]} args */
                handler: ([descriptor, token, desired, mapping, privileges, privilegesLength,
                    granted, status])=>{
                    if ((granted >>> 0) === 0 || (status >>> 0) === 0)
                    {
                        return STATUS_ACCESS_VIOLATION;
                    }
                    const verdict = evaluateAccess(descriptor, token, desired, mapping, privileges,
                        privilegesLength);
                    if (verdict.code !== ERROR_SUCCESS)
                    {
                        return verdict.code === ERROR_INSUFFICIENT_BUFFER
                            ? STATUS_BUFFER_TOO_SMALL : statusOf(verdict.code);
                    }
                    writeDword(granted >>> 0, verdict.granted ?? 0);
                    writeDword(status >>> 0, verdict.ok ? STATUS_SUCCESS : STATUS_ACCESS_DENIED);
                    return STATUS_SUCCESS;
                },
            },

            /**
             * NTSTATUS NtDuplicateToken(HANDLE ExistingToken, ACCESS_MASK,
             *   POBJECT_ATTRIBUTES, BOOLEAN EffectiveOnly, TOKEN_TYPE, PHANDLE)
             *
             * DuplicateTokenEx answered as a status. The impersonation level
             * is the one the OBJECT_ATTRIBUTES' SecurityQualityOfService names,
             * SecurityAnonymous when it carries none, and it rides a new
             * impersonation token (a primary one carries none, telling the two
             * apart as GetTokenInformation does).
             */
            NtDuplicateToken: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([existing, , attributes, , type, out])=>{
                    const token = tokenNamed(existing);
                    if (!token)
                    {
                        return STATUS_INVALID_HANDLE;
                    }
                    if ((out >>> 0) === 0)
                    {
                        return STATUS_ACCESS_VIOLATION;
                    }
                    // OBJECT_ATTRIBUTES.SecurityQualityOfService is its last
                    // field (+20); the level is that structure's second (+4).
                    let level = 0;
                    if ((attributes >>> 0) !== 0)
                    {
                        const qos = readDword((attributes >>> 0) + 20);
                        if (qos !== 0)
                        {
                            level = readDword(qos + 4);
                        }
                    }
                    writeDword(out >>> 0, host.handles.open('token', {
                        ...token,
                        impersonationLevel: (type >>> 0) === TOKEN_IMPERSONATION ? level >>> 0
                            : undefined,
                    }));
                    return STATUS_SUCCESS;
                },
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
            handler: ([descriptor])=>(anyDescriptor(descriptor) === null
                ? fail(ERROR_INVALID_SECURITY_DESCR) : 1),
        },

        /**
         * BOOL GetSecurityDescriptorControl(PSECURITY_DESCRIPTOR,
         *   PSECURITY_DESCRIPTOR_CONTROL pControl, LPDWORD lpdwRevision)
         */
        GetSecurityDescriptorControl: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([descriptor, control, revision])=>{
                const held = anyDescriptor(descriptor);
                if (held === null)
                {
                    return fail((descriptor >>> 0) === 0 ? ERROR_INVALID_SECURITY_DESCR
                        : ERROR_UNKNOWN_REVISION);
                }
                if ((control >>> 0) === 0 || (revision >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeWord(control >>> 0, held.control);
                writeDword(revision >>> 0, SECURITY_DESCRIPTOR_REVISION);
                return 1;
            },
        },

        /** BOOL GetSecurityDescriptorOwner(PSECURITY_DESCRIPTOR, PSID *, LPBOOL) */
        GetSecurityDescriptorOwner: getSidOf(SD.OWNER, SE_OWNER_DEFAULTED),

        /** BOOL GetSecurityDescriptorGroup(PSECURITY_DESCRIPTOR, PSID *, LPBOOL) */
        GetSecurityDescriptorGroup: getSidOf(SD.GROUP, SE_GROUP_DEFAULTED),

        /** BOOL GetSecurityDescriptorDacl(PSECURITY_DESCRIPTOR, LPBOOL, PACL *, LPBOOL) */
        GetSecurityDescriptorDacl: getAclOf(SD.DACL, SE_DACL_PRESENT, SE_DACL_DEFAULTED),

        /** BOOL GetSecurityDescriptorSacl(PSECURITY_DESCRIPTOR, LPBOOL, PACL *, LPBOOL) */
        GetSecurityDescriptorSacl: getAclOf(SD.SACL, SE_SACL_PRESENT, SE_SACL_DEFAULTED),

        /**
         * DWORD GetSecurityDescriptorLength(PSECURITY_DESCRIPTOR)
         *
         * What the descriptor takes made self-relative: its header and each
         * part it holds, as MakeSelfRelativeSD would lay them out.
         */
        GetSecurityDescriptorLength: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([descriptor])=>{
                const held = anyDescriptor(descriptor);
                if (held === null)
                {
                    return 0;
                }
                return SD.SIZE + sidLength(held.part(SD.OWNER)) + sidLength(held.part(SD.GROUP))
                    + ((held.control & SE_DACL_PRESENT) !== 0 ? aclLength(held.part(SD.DACL)) : 0)
                    + ((held.control & SE_SACL_PRESENT) !== 0 ? aclLength(held.part(SD.SACL)) : 0);
            },
        },

        /**
         * BOOL IsValidAcl(PACL pAcl)
         *
         * A revision an ACL may have, and ACEs that fit in the size it gives.
         */
        IsValidAcl: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([acl])=>((acl >>> 0) !== 0 && acesOf(acl) !== null ? 1 : 0),
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
            handler: ([acl, revision, mask, sid])=>
                addAce(acl, ACCESS_ALLOWED_ACE_TYPE, mask, sid, 0, revision),
        },

        /**
         * BOOL AddAccessAllowedAceEx(PACL, DWORD dwAceRevision, DWORD AceFlags,
         *   DWORD AccessMask, PSID)
         * BOOL AddAccessDeniedAceEx(PACL, DWORD, DWORD AceFlags, DWORD, PSID)
         *
         * As the plain ones, with the ACE's inheritance flags.
         */
        AddAccessAllowedAceEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([acl, revision, flags, mask, sid])=>
                addAce(acl, ACCESS_ALLOWED_ACE_TYPE, mask, sid, flags, revision),
        },
        AddAccessDeniedAceEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([acl, revision, flags, mask, sid])=>
                addAce(acl, ACCESS_DENIED_ACE_TYPE, mask, sid, flags, revision),
        },

        /**
         * BOOL AddAuditAccessAce(PACL, DWORD dwAceRevision, DWORD dwAccessMask,
         *   PSID, BOOL bAuditSuccess, BOOL bAuditFailure)
         * BOOL AddAuditAccessAceEx(PACL, DWORD, DWORD AceFlags, DWORD, PSID, BOOL, BOOL)
         *
         * An audit ACE, the outcomes it audits written as its two flags.
         */
        AddAuditAccessAce: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([acl, revision, mask, sid, success, failure])=>addAce(acl,
                SYSTEM_AUDIT_ACE_TYPE, mask, sid, (success ? SUCCESSFUL_ACCESS_ACE_FLAG : 0)
                    | (failure ? FAILED_ACCESS_ACE_FLAG : 0), revision),
        },
        AddAuditAccessAceEx: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([acl, revision, flags, mask, sid, success, failure])=>addAce(acl,
                SYSTEM_AUDIT_ACE_TYPE, mask, sid, flags & INHERITANCE_FLAGS
                    | (success ? SUCCESSFUL_ACCESS_ACE_FLAG : 0)
                    | (failure ? FAILED_ACCESS_ACE_FLAG : 0), revision),
        },

        /**
         * BOOL AddMandatoryAce(PACL, DWORD dwAceRevision, DWORD AceFlags,
         *   DWORD MandatoryPolicy, PSID pLabelSid)
         *
         * An integrity label: its mask is the policy, no-write-up, no-read-up
         * and no-execute-up and nothing else.
         */
        AddMandatoryAce: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([acl, revision, flags, policy, sid])=>{
                if (((policy >>> 0) & ~MANDATORY_POLICIES) !== 0
                    || ((flags >>> 0) & ~INHERITANCE_FLAGS) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return addAce(acl, SYSTEM_MANDATORY_LABEL_ACE_TYPE, policy, sid, flags, revision);
            },
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
            handler: ([acl, revision, index, list, length])=>{
                const aces = (acl >>> 0) === 0 ? null : acesOf(acl);
                if (aces === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
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
                raiseRevision(acl, revision);
                return 1;
            },
        },

        /**
         * BOOL AddAccessDeniedAce(PACL pAcl, DWORD dwAceRevision, DWORD AccessMask, PSID pSid)
         */
        AddAccessDeniedAce: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([acl, revision, mask, sid])=>
                addAce(acl, ACCESS_DENIED_ACE_TYPE, mask, sid, 0, revision),
        },

        /**
         * BOOL GetAce(PACL pAcl, DWORD dwAceIndex, LPVOID *pAce)
         *
         * Where the ACE at an index starts, inside the caller's own ACL: a
         * pointer, not a copy, so what the caller changes through it is the
         * ACL's. An index past the last, or an ACL that is not one, is
         * ERROR_INVALID_PARAMETER.
         */
        GetAce: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([acl, index, out])=>{
                const aces = (acl >>> 0) === 0 ? null : acesOf(acl);
                if (aces === null || (index >>> 0) >= aces.length || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, (acl >>> 0) + aces[index >>> 0].at);
                return 1;
            },
        },

        /**
         * DWORD SetEntriesInAclA(ULONG, PEXPLICIT_ACCESS_A, PACL OldAcl, PACL *NewAcl)
         * DWORD SetEntriesInAclW(ULONG, PEXPLICIT_ACCESS_W, PACL OldAcl, PACL *NewAcl)
         *
         * The answer is the error code; the last error is left alone.
         */
        SetEntriesInAclA: setEntriesInAcl(false),
        SetEntriesInAclW: setEntriesInAcl(true),

        /**
         * DWORD GetSecurityInfo(HANDLE handle, SE_OBJECT_TYPE ObjectType,
         *   SECURITY_INFORMATION SecurityInfo, PSID *ppsidOwner, PSID *ppsidGroup,
         *   PACL *ppDacl, PACL *ppSacl, PSECURITY_DESCRIPTOR *ppSecurityDescriptor)
         *
         * The object's descriptor with the parts asked for, self-relative in a
         * LocalAlloc block, the part pointers into it. With nowhere to put any
         * of it the call is refused, the last error left alone. A service's
         * descriptor is the service manager's; any other handle is a kernel
         * object's.
         */
        GetSecurityInfo: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, type, wanted, owner, group, dacl, sacl,
                descriptor])=>{
                const outs = [owner, group, dacl, sacl, descriptor];
                if (outs.every(out=>(out >>> 0) === 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const bytes = (type >>> 0) === SE_SERVICE
                    ? host.serviceSecurity?.(handle >>> 0, wanted >>> 0) ?? null
                    : kernelDescriptor(handle, wanted >>> 0);
                if (bytes === null)
                {
                    return ERROR_INVALID_HANDLE;
                }
                const block = host.allocate(bytes.length);
                host.writeMemory(block, bytes);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
                [[owner, SD.OWNER], [group, SD.GROUP], [sacl, SD.SACL], [dacl, SD.DACL]]
                    .forEach(([out, slot])=>{
                        if ((out >>> 0) !== 0)
                        {
                            const offset = view.getUint32(slot, true);
                            writeDword(out >>> 0, offset === 0 ? 0 : block + offset);
                        }
                    });
                if ((descriptor >>> 0) !== 0)
                {
                    writeDword(descriptor >>> 0, block);
                }
                return ERROR_SUCCESS;
            },
        },

        /**
         * DWORD SetSecurityInfo(HANDLE handle, SE_OBJECT_TYPE ObjectType,
         *   SECURITY_INFORMATION SecurityInfo, PSID psidOwner, PSID psidGroup,
         *   PACL pDacl, PACL pSacl)
         *
         * The parts given become the kernel object's; a service's are taken
         * and kept nowhere, as the service manager here keeps none.
         */
        SetSecurityInfo: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, type, wanted, owner, group, dacl, sacl])=>{
                if ((type >>> 0) === SE_SERVICE)
                {
                    return ERROR_SUCCESS;
                }
                const object = kernelObject(handle);
                if (object === null)
                {
                    return ERROR_INVALID_HANDLE;
                }
                /** @param {number} acl */
                const aclOf = acl=>(acl === 0 ? null
                    : host.readMemory(acl, aclLength(acl)).slice());
                const parts = { control: SE_DACL_PRESENT | SE_SACL_PRESENT,
                    owner: sidAt(owner) ?? undefined, group: sidAt(group) ?? undefined,
                    dacl: aclOf(dacl >>> 0), sacl: aclOf(sacl >>> 0) };
                storeParts(object, parts, wanted >>> 0);
                return ERROR_SUCCESS;
            },
        },

        /**
         * BOOL GetKernelObjectSecurity(HANDLE Handle, SECURITY_INFORMATION
         *   RequestedInformation, PSECURITY_DESCRIPTOR pSecurityDescriptor,
         *   DWORD nLength, LPDWORD lpnLengthNeeded)
         *
         * The object's descriptor, self-relative, with the parts asked for.
         * Until a program sets one, an object the one account made is owned by
         * BUILTIN\Administrators, as an elevated administrator's objects are,
         * its group the account's primary one, and its DACL the token's
         * default -- everything to the administrators and to the system. Too
         * small a buffer is the documented ERROR_INSUFFICIENT_BUFFER with the
         * size needed, which is how a caller learns it.
         */
        GetKernelObjectSecurity: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, requested, descriptor, length, needed])=>{
                const bytes = kernelDescriptor(handle, requested >>> 0);
                if (bytes === null)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((needed >>> 0) !== 0)
                {
                    writeDword(needed >>> 0, bytes.length);
                }
                if ((length >>> 0) < bytes.length || (descriptor >>> 0) === 0)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(descriptor >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL SetKernelObjectSecurity(HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR)
         *
         * The parts the information names, taken from the descriptor, become
         * the object's: what the next GetKernelObjectSecurity answers.
         */
        SetKernelObjectSecurity: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, wanted, descriptor])=>{
                const object = kernelObject(handle);
                if (object === null)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const parts = codec.partsOf(descriptor);
                if (parts === null)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                storeParts(object, parts, wanted >>> 0);
                return 1;
            },
        },

        /**
         * void MapGenericMask(PDWORD AccessMask, PGENERIC_MAPPING GenericMapping)
         *
         * Each generic right in the mask replaced by the specific rights the
         * mapping gives it, as AccessCheck maps the access it is asked for.
         */
        MapGenericMask: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([mask, mapping])=>{
                const map = [0, 4, 8, 12].map(offset=>readDword((mapping >>> 0) + offset));
                writeDword(mask >>> 0, mapGeneric(readDword(mask >>> 0), map));
                return 0;
            },
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
                granted, status])=>accessCheck(descriptor, token, desired, mapping, privileges,
                privilegesLength, granted, status),
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
            handler: ([thread, , , out])=>{
                const named = threadNamed(thread);
                if (named === null)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const token = impersonating.get(named);
                if (!token)
                {
                    return fail(ERROR_NO_TOKEN);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, host.handles.open('token', token));
                return 1;
            },
        },

        /**
         * BOOL SetThreadToken(PHANDLE Thread, HANDLE Token)
         *
         * The token a thread impersonates with -- the calling thread's when
         * no thread is named. NULL reverts it to acting as the process; a
         * primary token is not one a thread can impersonate with, and is
         * refused with ERROR_BAD_TOKEN_TYPE as Windows refuses it.
         * OpenThreadToken opens what was set.
         */
        SetThreadToken: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([threadPointer, tokenHandle])=>{
                const thread = (threadPointer >>> 0) === 0 ? callingThread()
                    : threadNamed(readDword(threadPointer));
                if (thread === null)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((tokenHandle >>> 0) === 0)
                {
                    impersonating.delete(thread);
                    return 1;
                }
                const token = isToken(tokenHandle)
                    ? host.handles.resolve(tokenHandle >>> 0, 'token') : null;
                if (!token)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (token.impersonationLevel === undefined)
                {
                    return fail(ERROR_BAD_TOKEN_TYPE);
                }
                impersonating.set(thread, token);
                return 1;
            },
        },

        /**
         * BOOL ImpersonateSelf(SECURITY_IMPERSONATION_LEVEL ImpersonationLevel)
         *
         * The calling thread impersonates the process's own account, at the
         * level asked for: the one impersonation that always succeeds, after
         * which OpenThreadToken finds a token.
         */
        ImpersonateSelf: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([level])=>{
                impersonating.set(callingThread(),
                    { process: CURRENT_PROCESS, impersonationLevel: level >>> 0 });
                return 1;
            },
        },

        /**
         * BOOL RevertToSelf(VOID)
         *
         * The calling thread stops impersonating, whatever it was given; one
         * that was not is already reverted.
         */
        RevertToSelf: {
            argBytes: 0,
            handler: ()=>{
                impersonating.delete(callingThread());
                return 1;
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
         * BOOL DuplicateTokenEx(HANDLE hExistingToken, DWORD dwDesiredAccess,
         *   LPSECURITY_ATTRIBUTES, SECURITY_IMPERSONATION_LEVEL, TOKEN_TYPE TokenType,
         *   PHANDLE phNewToken)
         *
         * DuplicateToken with the type chosen: a primary token carries no
         * impersonation level, which is how GetTokenInformation tells them apart.
         */
        DuplicateTokenEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([existing, , , level, type, out])=>{
                const token = tokenNamed(existing);
                if (!token)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0 || ((type >>> 0) !== TOKEN_PRIMARY
                    && (type >>> 0) !== TOKEN_IMPERSONATION) || (level >>> 0) > 3)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, host.handles.open('token', {
                    ...token,
                    impersonationLevel: (type >>> 0) === TOKEN_IMPERSONATION ? level >>> 0
                        : undefined,
                }));
                return 1;
            },
        },

        /**
         * BOOL CreateRestrictedToken(HANDLE ExistingTokenHandle, DWORD Flags,
         *   DWORD DisableSidCount, PSID_AND_ATTRIBUTES SidsToDisable,
         *   DWORD DeletePrivilegeCount, PLUID_AND_ATTRIBUTES PrivilegesToDelete,
         *   DWORD RestrictedSidCount, PSID_AND_ATTRIBUTES SidsToRestrict,
         *   PHANDLE NewTokenHandle)
         *
         * A new token of the same type as the one it is made from, the SIDs
         * to disable kept on it; with one account and no access checks those
         * change nothing a caller can see but the token's own answers.
         */
        CreateRestrictedToken: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [existing, , disableCount, disable, , , , , out])=>{
                const token = tokenNamed(existing);
                if (!token)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const disabled = [];
                for (let at = 0; at < (disableCount >>> 0); at++)
                {
                    const sid = sidAt(readDword((disable >>> 0) + at * SID_AND_ATTRIBUTES_SIZE));
                    if (sid === null)
                    {
                        return fail(ERROR_INVALID_SID);
                    }
                    disabled.push(sid);
                }
                writeDword(out >>> 0, host.handles.open('token', {
                    ...token, disabled: [...token.disabled ?? [], ...disabled],
                }));
                return 1;
            },
        },

        /**
         * BOOL SetTokenInformation(HANDLE TokenHandle, TOKEN_INFORMATION_CLASS,
         *   LPVOID TokenInformation, DWORD TokenInformationLength)
         *
         * The classes a caller may set -- the default owner, group and DACL,
         * the session, the integrity level -- are accepted; there is one
         * account, and nothing here makes an object with them.
         */
        SetTokenInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([token, tokenClass, given, length])=>{
                const held = tokenNamed(token);
                if (!held)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((length >>> 0) === 0)
                {
                    return fail(ERROR_BAD_LENGTH);
                }
                if ((given >>> 0) === 0)
                {
                    return fail(ERROR_NOACCESS);
                }
                if ((tokenClass >>> 0) === TokenDefaultDacl)
                {
                    const acl = readDword(given);
                    defaultDacls.set(held.process ?? held, acl === 0 ? null
                        : host.readMemory(acl, readWord(acl + ACL.SIZE)).slice());
                    return 1;
                }
                return SETTABLE_TOKEN_CLASSES.has(tokenClass >>> 0) ? 1
                    : fail(ERROR_INVALID_PARAMETER);
            },
        },

        /**
         * BOOL ImpersonateLoggedOnUser(HANDLE hToken)
         *
         * The calling thread acts as the token's user. A primary token is
         * accepted too, impersonated at the impersonation level.
         */
        ImpersonateLoggedOnUser: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const token = tokenNamed(handle);
                if (!token)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                impersonating.set(callingThread(), token.impersonationLevel === undefined
                    ? { ...token, impersonationLevel: SECURITY_IMPERSONATION } : token);
                return 1;
            },
        },

        LookupAccountNameA: lookupAccountName(false),
        LookupAccountNameW: lookupAccountName(true),

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
                // An account with no split token has no linked one.
                if ((tokenClass >>> 0) === TokenLinkedToken)
                {
                    return fail(ERROR_NO_SUCH_LOGON_SESSION);
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
                // A success leaves the last error as it was.
                host.writeMemory(buffer >>> 0, whole);
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
         * BOOL LookupPrivilegeValueW(LPCWSTR lpSystemName, LPCWSTR lpName, PLUID lpLuid)
         *
         * Found whatever the name's case, as Windows finds it. A NULL name is
         * no privilege, as Windows' own tests see it answered; the machine is
         * this one, named by NULL or its own name, and any other is out of
         * reach with no network.
         */
        LookupPrivilegeValueA: lookupPrivilegeValue(false),
        LookupPrivilegeValueW: lookupPrivilegeValue(true),

        /**
         * BOOL LookupAccountSidA(LPCSTR, PSID, LPSTR, LPDWORD, LPSTR, LPDWORD, PSID_NAME_USE)
         * BOOL LookupAccountSidW(LPCWSTR, PSID, LPWSTR, LPDWORD, LPWSTR, LPDWORD, PSID_NAME_USE)
         *
         * The names an English Windows XP gives: Everyone with no domain,
         * NT AUTHORITY\SYSTEM, BUILTIN\Administrators, this machine's own
         * accounts under its name -- the one account among them, as
         * GetUserName names it. A SID this machine has no name for is
         * ERROR_NONE_MAPPED.
         */
        LookupAccountSidA: lookupAccountSid(false),
        LookupAccountSidW: lookupAccountSid(true),

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
         * BOOL PrivilegeCheck(HANDLE ClientToken, PPRIVILEGE_SET RequiredPrivileges,
         *   LPBOOL pfResult)
         *
         * Held, every one: the same administrator's token AdjustTokenPrivileges
         * grants everything on. Each privilege in the set (12 bytes past the
         * count and the control word: its LUID and its attributes) is marked
         * SE_PRIVILEGE_USED_FOR_ACCESS, as the check marks the ones it found.
         */
        PrivilegeCheck: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([token, set, result])=>{
                if (!isToken(token))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((set >>> 0) === 0 || (result >>> 0) === 0)
                {
                    return fail(ERROR_NOACCESS);
                }
                const view = new DataView(host.readMemory(set >>> 0, 4).slice().buffer);
                const count = view.getUint32(0, true);
                for (let at = 0; at < count; at++)
                {
                    const attributes = (set >>> 0) + 8 + 12 * at + 8;
                    const old = new DataView(host.readMemory(attributes, 4).slice().buffer)
                        .getUint32(0, true);
                    writeDword(attributes, old | SE_PRIVILEGE_USED_FOR_ACCESS);
                }
                writeDword(result >>> 0, 1);
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
        /**
         * BOOL ConvertStringSecurityDescriptorToSecurityDescriptorA(LPCSTR
         *     StringSecurityDescriptor, DWORD StringSDRevision,
         *     PSECURITY_DESCRIPTOR *SecurityDescriptor, PULONG SecurityDescriptorSize)
         * and the W form.
         *
         * The descriptor the SDDL names (parseSddl), self-relative, in a
         * LocalAlloc block the caller frees with LocalFree; only SDDL_REVISION_1
         * exists, and text that names no descriptor is ERROR_INVALID_PARAMETER.
         */
        ConvertStringSecurityDescriptorToSecurityDescriptorA: convertDescriptor(false),
        ConvertStringSecurityDescriptorToSecurityDescriptorW: convertDescriptor(true),

        ConvertSidToStringSidA: convertSid(false),
        ConvertSidToStringSidW: convertSid(true),

        /**
         * BOOL ConvertStringSidToSidA(LPCSTR StringSid, PSID *Sid)
         * BOOL ConvertStringSidToSidW(LPCWSTR StringSid, PSID *Sid)
         *
         * The SID a text names (parseSid), in a LocalAlloc block the caller
         * frees with LocalFree; text that names none is ERROR_INVALID_SID.
         */
        ConvertStringSidToSidA: convertText(false),
        ConvertStringSidToSidW: convertText(true),

        /**
         * BOOL CopySid(DWORD nDestinationSidLength, PSID pDestinationSid, PSID pSourceSid)
         *
         * The SID's bytes into a buffer of the caller's, which has to hold all
         * of it: one that does not is refused with ERROR_INSUFFICIENT_BUFFER
         * and nothing is written.
         */
        CopySid: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([room, destination, source])=>{
                if ((destination >>> 0) === 0 || (source >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const length = 8 + 4 * host.readMemory(source >>> 0, 2)[1];
                if ((room >>> 0) < length)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(destination >>> 0, host.readMemory(source >>> 0, length).slice());
                return 1;
            },
        },

        /**
         * PSID_IDENTIFIER_AUTHORITY GetSidIdentifierAuthority(PSID pSid)
         * PDWORD GetSidSubAuthority(PSID pSid, DWORD nSubAuthority)
         * PUCHAR GetSidSubAuthorityCount(PSID pSid)
         *
         * Pointers into the SID itself -- the six-byte authority after the
         * revision and the count, the count, a sub-authority by its index --
         * so a program writes a SID it initialised through them. Nothing is
         * checked, as Windows checks nothing: the last error is set to
         * success, which is how a caller tells the pointer is good.
         */
        GetSidIdentifierAuthority: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([sid])=>{
                host.setLastError(ERROR_SUCCESS);
                return ((sid >>> 0) + 2) >>> 0;
            },
        },
        GetSidSubAuthority: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([sid, index])=>{
                host.setLastError(ERROR_SUCCESS);
                return ((sid >>> 0) + 8 + 4 * (index >>> 0)) >>> 0;
            },
        },
        GetSidSubAuthorityCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([sid])=>{
                host.setLastError(ERROR_SUCCESS);
                return ((sid >>> 0) + 1) >>> 0;
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
