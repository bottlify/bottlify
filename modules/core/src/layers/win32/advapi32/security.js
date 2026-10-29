/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The security calls that only rearrange bytes the caller holds: well-known
 * SIDs, SID prefixes and domains, trustees, an ACL's sizes, a descriptor's
 * control word and its two forms, the SDDL text of a descriptor, and the
 * explicit entries of an ACL. None of them asks who the account is or what an
 * object allows -- tokens.js answers those -- so each is the layout Windows
 * documents for it, and the errors it documents for a layout that is not one.
 */

import {
    ACL_HEADER, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION,
    LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SACL_SECURITY_INFORMATION, SD,
    SE_DACL_AUTO_INHERITED, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_DEFAULTED, SE_DACL_PRESENT,
    SE_DACL_PROTECTED, SE_GROUP_DEFAULTED, SE_OWNER_DEFAULTED, SE_SACL_AUTO_INHERITED,
    SE_SACL_AUTO_INHERIT_REQ, SE_SACL_DEFAULTED, SE_SACL_PRESENT, SE_SACL_PROTECTED,
    SE_RM_CONTROL_VALID, SE_SELF_RELATIVE, createDescriptorCodec,
} from './descriptors.js';
import {
    PRIVILEGES, SDDL_ACE_FLAGS, SDDL_RIGHTS, SDDL_SIDS, encodeText, isThisMachine, sidBytes,
    sidText, wideTextAt,
} from './tokens.js';

const ERROR_SUCCESS = 0;
const ERROR_NOACCESS = 998;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_SUCH_PRIVILEGE = 1313;
const ERROR_INVALID_ACL = 1336;
const ERROR_INVALID_SID = 1337;
const ERROR_INVALID_SECURITY_DESCR = 1338;
const ERROR_BAD_DESCRIPTOR_FORMAT = 1361;
const ERROR_NON_ACCOUNT_SID = 1257;
const ERROR_NON_DOMAIN_SID = 1258;
const ERROR_UNKNOWN_REVISION = 1305;
const RPC_S_SERVER_UNAVAILABLE = 1722;

/**
 * What SetSecurityDescriptorControl may not touch: whether a part is there
 * and defaulted is the setters' to say, and the form is fixed when the
 * descriptor is made. The other eight bits, two of them unnamed, are free.
 */
const IMMUTABLE_CONTROL = SE_OWNER_DEFAULTED | SE_GROUP_DEFAULTED | SE_DACL_PRESENT
    | SE_DACL_DEFAULTED | SE_SACL_PRESENT | SE_SACL_DEFAULTED | SE_RM_CONTROL_VALID
    | SE_SELF_RELATIVE;

const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACCESS_DENIED_ACE_TYPE = 1;
const SYSTEM_AUDIT_ACE_TYPE = 2;
const SYSTEM_ALARM_ACE_TYPE = 3;
const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;
const SUCCESSFUL_ACCESS_ACE_FLAG = 0x40;
const FAILED_ACCESS_ACE_FLAG = 0x80;
const INHERITED_ACE = 0x10;
/** The inheritance bits of an ACE's flags, which EXPLICIT_ACCESS carries over. */
const VALID_INHERIT_FLAGS = 0x1f;

/** ACL_INFORMATION_CLASS. */
const AclRevisionInformation = 1;
const AclSizeInformation = 2;

/** TRUSTEE: four DWORDs and the name, which each form reads its own way. */
const TRUSTEE = Object.freeze({ MULTIPLE: 0, OPERATION: 4, FORM: 8, TYPE: 12, NAME: 16,
    SIZE: 20 });
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_NAME = 1;
const TRUSTEE_IS_OBJECTS_AND_SID = 3;
const TRUSTEE_IS_OBJECTS_AND_NAME = 4;
const TRUSTEE_IS_UNKNOWN = 0;
const NO_MULTIPLE_TRUSTEE = 0;
const ACE_OBJECT_TYPE_PRESENT = 1;
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 2;

/** EXPLICIT_ACCESS: permissions, mode, inheritance, then the trustee. */
const EXPLICIT_ACCESS_SIZE = 12 + TRUSTEE.SIZE;
const GRANT_ACCESS = 1;
const DENY_ACCESS = 3;
const SET_AUDIT_SUCCESS = 5;
const SET_AUDIT_FAILURE = 6;

const SDDL_REVISION_1 = 1;

/** The WELL_KNOWN_SID_TYPE of a logon session's SID, which has no one value. */
const WinLogonIdsSid = 21;

/**
 * WELL_KNOWN_SID_TYPE, by its number: the SID's text, "D" where the domain
 * the caller passes goes, and null for the numbers that name no fixed SID
 * (a logon session's, which differs per logon). Fixed by the enumeration in
 * winnt.h, the same on every machine.
 *
 * @type {(string | null)[]}
 */
const WELL_KNOWN_SIDS = [
    'S-1-0-0', 'S-1-1-0', 'S-1-2-0', 'S-1-3-0', 'S-1-3-1', 'S-1-3-2', 'S-1-3-3', 'S-1-5',
    'S-1-5-1', 'S-1-5-2', 'S-1-5-3', 'S-1-5-4', 'S-1-5-6', 'S-1-5-7', 'S-1-5-8', 'S-1-5-9',
    'S-1-5-10', 'S-1-5-11', 'S-1-5-12', 'S-1-5-13', 'S-1-5-14', null, 'S-1-5-18', 'S-1-5-19',
    'S-1-5-20', 'S-1-5-32', 'S-1-5-32-544', 'S-1-5-32-545', 'S-1-5-32-546', 'S-1-5-32-547',
    'S-1-5-32-548', 'S-1-5-32-549', 'S-1-5-32-550', 'S-1-5-32-551', 'S-1-5-32-552',
    'S-1-5-32-554', 'S-1-5-32-555', 'S-1-5-32-556', 'D-500', 'D-501', 'D-502', 'D-512',
    'D-513', 'D-514', 'D-515', 'D-516', 'D-517', 'D-518', 'D-519', 'D-520', 'D-553',
    'S-1-5-64-10', 'S-1-5-64-21', 'S-1-5-64-14', 'S-1-5-15', 'S-1-5-1000', 'S-1-5-32-557',
    'S-1-5-32-558', 'S-1-5-32-559', 'S-1-5-32-560', 'S-1-5-32-561', 'S-1-5-32-562',
    'S-1-5-32-568', 'S-1-5-17', 'S-1-5-32-569', 'S-1-16-0', 'S-1-16-4096', 'S-1-16-8192',
    'S-1-16-12288', 'S-1-16-16384', 'S-1-5-33', 'S-1-3-4', 'D-571', 'D-572', 'S-1-5-22',
    'D-521', 'S-1-5-32-573', 'D-498', 'S-1-5-32-574', 'S-1-16-8448', null, 'S-1-2-1',
    'S-1-5-65-1', null, 'S-1-15-2-1',
];

/**
 * The ACE types SDDL writes with letters, beyond the four tokens.js reads:
 * a mandatory label is one more trustee ACE.
 */
const SDDL_TYPE_NAMES = new Map([
    [ACCESS_ALLOWED_ACE_TYPE, 'A'], [ACCESS_DENIED_ACE_TYPE, 'D'],
    [SYSTEM_AUDIT_ACE_TYPE, 'AU'], [SYSTEM_ALARM_ACE_TYPE, 'AL'],
    [SYSTEM_MANDATORY_LABEL_ACE_TYPE, 'ML'],
]);

/**
 * Rights SDDL writes by one name for the whole mask -- a file's or a key's
 * full, read, write and execute access -- before it spells out bits.
 */
const SDDL_WHOLE_RIGHTS = ['FA', 'FR', 'FW', 'FX', 'KA', 'KR', 'KW']
    .map(name=>/** @type {[string, number]} */ ([name, SDDL_RIGHTS[
        /** @type {keyof typeof SDDL_RIGHTS} */ (name)]]));

/**
 * The bits SDDL names one at a time, lowest first, which is the order it
 * writes them in; a mask with a bit none of these names is written in hex.
 */
const SDDL_RIGHT_BITS = ['CC', 'DC', 'LC', 'SW', 'RP', 'WP', 'DT', 'LO', 'CR', 'SD', 'RC',
    'WD', 'WO', 'GA', 'GX', 'GW', 'GR']
    .map(name=>/** @type {[string, number]} */ ([name, SDDL_RIGHTS[
        /** @type {keyof typeof SDDL_RIGHTS} */ (name)] >>> 0]));

/** The policy bits of a mandatory label: no write, read or execute up. */
const SDDL_LABEL_BITS = /** @type {[string, number][]} */ ([['NW', 1], ['NR', 2], ['NX', 4]]);

/** The ACE flags in the order SDDL writes them: inheritance, then audit outcomes. */
const SDDL_FLAG_BITS = ['OI', 'CI', 'NP', 'IO', 'ID', 'SA', 'FA']
    .map(name=>/** @type {[string, number]} */ ([name, SDDL_ACE_FLAGS[
        /** @type {keyof typeof SDDL_ACE_FLAGS} */ (name)]]));

/** @param {Uint8Array} left @param {Uint8Array} right */
const sameBytes = (left, right)=>left.length === right.length
    && left.every((byte, at)=>byte === right[at]);

/** SDDL's two letters for each SID it names, by the SID's text. */
const SDDL_NAMES = new Map(Object.entries(SDDL_SIDS)
    .map(([name, sid])=>[sidText(sidBytes(sid)), name]));

/** @param {Uint8Array} sid  The SID as SDDL writes it: its two letters, or its text. */
const sddlSid = sid=>{
    const text = sidText(sid);
    return SDDL_NAMES.get(text) ?? text;
};

/**
 * @param {number} mask @param {[string, number][]} bits
 * @returns {string} the mask as SDDL's names, or in hex when one bit has none
 */
const sddlMask = (mask, bits)=>{
    let rest = mask >>> 0;
    let text = '';
    for (const [name, bit] of bits)
    {
        if ((rest & bit) !== 0)
        {
            text += name;
            rest = (rest & ~bit) >>> 0;
        }
    }
    return rest === 0 ? text : `0x${(mask >>> 0).toString(16)}`;
};

/**
 * @param {string} text @param {Uint8Array | null} domain  The domain the text's
 *   D stands for. @returns {Uint8Array | null} the SID, laid out
 */
const wellKnownSid = (text, domain)=>{
    const numbers = text.split('-');
    if (numbers[0] === 'D')
    {
        if (domain === null)
        {
            return null;
        }
        const sid = new Uint8Array(domain.length + 4);
        sid.set(domain);
        sid[1] = domain[1] + 1;
        new DataView(sid.buffer).setUint32(domain.length, Number(numbers[1]), true);
        return sid;
    }
    return sidBytes({ authority: Number(numbers[2]),
        subAuthorities: numbers.slice(3).map(Number) });
};

/**
 * The domain a SID belongs to, as EqualDomainSid compares them: the built-in
 * one, or an account domain -- S-1-5-21 and the three numbers that name it.
 * Null for a SID that is in neither.
 *
 * @param {Uint8Array} sid
 */
const domainOf = sid=>{
    const view = new DataView(sid.buffer, sid.byteOffset, sid.length);
    const ntAuthority = view.getUint16(2) === 0 && view.getUint32(4) === 5;
    if (!ntAuthority || sid[1] === 0)
    {
        return null;
    }
    const first = view.getUint32(8, true);
    if (first === 32)
    {
        return sidBytes({ authority: 5, subAuthorities: [32] });
    }
    if (first === 21 && sid[1] >= 4)
    {
        const domain = sid.slice(0, 8 + 16);
        domain[1] = 4;
        return domain;
    }
    return null;
};

/**
 * @typedef {Object} SecurityHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} allocate  LocalFree-compatible.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {SecurityHost} host
 */
export function createSecurityFunctions(host){
    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };
    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const readWord = address=>{
        const bytes = host.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} value */
    const dwordBytes = value=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>host.writeMemory(address >>> 0, dwordBytes(value));
    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array([value & 0xff, value >>> 8 & 0xff]));

    const { sidAt, aclAt, acesIn, partsOf, selfRelative, partsAskedFor } =
        createDescriptorCodec(host.readMemory);

    /**
     * An ACL as SDDL writes it: the control flags that belong to it, then each
     * ACE in brackets; a null ACL is NO_ACCESS_CONTROL, as Windows since
     * Vista writes it.
     *
     * @param {Uint8Array | null} acl @param {string} flags
     * @returns {string | null} null when the ACL is not one
     */
    const sddlAcl = (acl, flags)=>{
        if (acl === null)
        {
            return `${flags}NO_ACCESS_CONTROL`;
        }
        const aces = acesIn(acl);
        if (aces === null)
        {
            return null;
        }
        let text = flags;
        for (const ace of aces)
        {
            const type = SDDL_TYPE_NAMES.get(ace.type);
            if (type === undefined || ace.sid === null)
            {
                return null;
            }
            const rights = ace.type === SYSTEM_MANDATORY_LABEL_ACE_TYPE
                ? sddlMask(ace.mask, SDDL_LABEL_BITS)
                : SDDL_WHOLE_RIGHTS.find(([, mask])=>mask === ace.mask)?.[0]
                    ?? sddlMask(ace.mask, SDDL_RIGHT_BITS);
            const aceFlags = sddlMask(ace.flags, SDDL_FLAG_BITS);
            text += `(${type};${aceFlags};${rights};;;${sddlSid(ace.sid)})`;
        }
        return text;
    };

    /**
     * @param {number} control @param {number} protectedBit @param {number} requestBit
     * @param {number} inheritedBit @returns {string} the flags SDDL writes before an ACL
     */
    const aclFlags = (control, protectedBit, requestBit, inheritedBit)=>
        ((control & protectedBit) !== 0 ? 'P' : '') + ((control & requestBit) !== 0 ? 'AR' : '')
        + ((control & inheritedBit) !== 0 ? 'AI' : '');

    /**
     * BOOL ConvertSecurityDescriptorToStringSecurityDescriptor(
     *   PSECURITY_DESCRIPTOR, DWORD RequestedStringSDRevision,
     *   SECURITY_INFORMATION, LPTSTR *StringSecurityDescriptor, PULONG StringSecurityDescriptorLen)
     *
     * The parts asked for, in the order O G D S, in a LocalAlloc block, and
     * its length with the terminator; a part the descriptor does not hold is
     * left out, so an empty descriptor is the empty string.
     *
     * @param {boolean} wide
     */
    const descriptorToString = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [descriptor, revision, wanted, out, length])=>{
            if ((out >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if ((revision >>> 0) !== SDDL_REVISION_1)
            {
                return fail(ERROR_UNKNOWN_REVISION);
            }
            const parts = partsOf(descriptor);
            if (parts === null)
            {
                return fail(ERROR_INVALID_SECURITY_DESCR);
            }
            let text = '';
            if ((wanted & OWNER_SECURITY_INFORMATION) !== 0 && parts.owner)
            {
                text += `O:${sddlSid(parts.owner)}`;
            }
            if ((wanted & GROUP_SECURITY_INFORMATION) !== 0 && parts.group)
            {
                text += `G:${sddlSid(parts.group)}`;
            }
            if ((wanted & DACL_SECURITY_INFORMATION) !== 0 && parts.dacl !== undefined)
            {
                const acl = sddlAcl(parts.dacl, aclFlags(parts.control, SE_DACL_PROTECTED,
                    SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED));
                if (acl === null)
                {
                    return fail(ERROR_INVALID_ACL);
                }
                text += `D:${acl}`;
            }
            if ((wanted & (SACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION)) !== 0
                && parts.sacl !== undefined)
            {
                const acl = sddlAcl(parts.sacl, aclFlags(parts.control, SE_SACL_PROTECTED,
                    SE_SACL_AUTO_INHERIT_REQ, SE_SACL_AUTO_INHERITED));
                if (acl === null)
                {
                    return fail(ERROR_INVALID_ACL);
                }
                text += `S:${acl}`;
            }
            const bytes = encodeText(text, wide);
            const block = host.allocate(bytes.length);
            host.writeMemory(block, bytes);
            writeDword(out >>> 0, block);
            if ((length >>> 0) !== 0)
            {
                writeDword(length >>> 0, text.length + 1);
            }
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

    /**
     * void BuildTrusteeWithSid(PTRUSTEE pTrustee, PSID pSid)
     * void BuildTrusteeWithName(PTRUSTEE pTrustee, LPTSTR pName)
     *
     * A single trustee of unknown type, named by what it is given; the
     * pointer is kept, not copied.
     *
     * @param {number} form
     */
    const buildTrustee = form=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([trustee, name])=>{
            writeTrustee(trustee, form, name);
            return 0;
        },
    });

    /** @param {number} trustee @param {number} form @param {number} name */
    const writeTrustee = (trustee, form, name)=>{
        const bytes = new Uint8Array(TRUSTEE.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(TRUSTEE.MULTIPLE, 0, true);
        view.setUint32(TRUSTEE.OPERATION, NO_MULTIPLE_TRUSTEE, true);
        view.setUint32(TRUSTEE.FORM, form, true);
        view.setUint32(TRUSTEE.TYPE, TRUSTEE_IS_UNKNOWN, true);
        view.setUint32(TRUSTEE.NAME, name >>> 0, true);
        host.writeMemory(trustee >>> 0, bytes);
    };

    /**
     * void BuildTrusteeWithObjectsAndSid(PTRUSTEE, POBJECTS_AND_SID pObjSid,
     *   GUID *pObjectGuid, GUID *pInheritedObjectGuid, PSID pSid)
     *
     * The OBJECTS_AND_SID filled in -- each GUID copied, and zero with its bit
     * clear when none is given -- and the trustee pointing at it.
     */
    const buildTrusteeWithObjectsAndSid = {
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [trustee, objects, objectType, inheritedType, sid])=>{
            const bytes = new Uint8Array(40);
            let present = 0;
            if ((objectType >>> 0) !== 0)
            {
                bytes.set(host.readMemory(objectType >>> 0, 16), 4);
                present |= ACE_OBJECT_TYPE_PRESENT;
            }
            if ((inheritedType >>> 0) !== 0)
            {
                bytes.set(host.readMemory(inheritedType >>> 0, 16), 20);
                present |= ACE_INHERITED_OBJECT_TYPE_PRESENT;
            }
            const view = new DataView(bytes.buffer);
            view.setUint32(0, present, true);
            view.setUint32(36, sid >>> 0, true);
            host.writeMemory(objects >>> 0, bytes);
            writeTrustee(trustee, TRUSTEE_IS_OBJECTS_AND_SID, objects);
            return 0;
        },
    };

    /**
     * void BuildTrusteeWithObjectsAndName(PTRUSTEE, POBJECTS_AND_NAME pObjName,
     *   SE_OBJECT_TYPE ObjectType, LPTSTR ObjectTypeName,
     *   LPTSTR InheritedObjectTypeName, LPTSTR Name)
     *
     * The names are kept as pointers; which of the two type names is given
     * is what ObjectsPresent says.
     */
    const buildTrusteeWithObjectsAndName = {
        argBytes: 24,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [trustee, objects, objectType, typeName,
            inheritedName, name])=>{
            const present = ((typeName >>> 0) !== 0 ? ACE_OBJECT_TYPE_PRESENT : 0)
                | ((inheritedName >>> 0) !== 0 ? ACE_INHERITED_OBJECT_TYPE_PRESENT : 0);
            host.writeMemory(objects >>> 0, new Uint8Array([
                ...dwordBytes(present), ...dwordBytes(objectType), ...dwordBytes(typeName),
                ...dwordBytes(inheritedName), ...dwordBytes(name),
            ]));
            writeTrustee(trustee, TRUSTEE_IS_OBJECTS_AND_NAME, objects);
            return 0;
        },
    };

    /**
     * BOOL LookupPrivilegeName(LPCTSTR lpSystemName, PLUID lpLuid, LPTSTR lpName,
     *   LPDWORD cchName)
     *
     * The name a LUID numbers; too small a buffer asks for the length with
     * its terminator, a fit answers the length without.
     *
     * @param {boolean} wide
     */
    const lookupPrivilegeName = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [system, luid, name, size])=>{
            const machine = (system >>> 0) === 0 ? null
                : wide ? wideTextAt(host.readMemory, system, 256)
                    : host.readCString(system >>> 0, 256);
            if (!isThisMachine(machine))
            {
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            if ((luid >>> 0) === 0 || (size >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const low = readDword(luid);
            const high = readDword((luid >>> 0) + 4);
            const found = high === 0
                ? [...PRIVILEGES].find(([, value])=>value === low)?.[0] : undefined;
            if (found === undefined)
            {
                return fail(ERROR_NO_SUCH_PRIVILEGE);
            }
            if (readDword(size) <= found.length || (name >>> 0) === 0)
            {
                writeDword(size, found.length + 1);
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            host.writeMemory(name >>> 0, encodeText(found, wide));
            writeDword(size, found.length);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    });

    /**
     * DWORD GetExplicitEntriesFromAcl(PACL pacl, PULONG pcCountOfExplicitEntries,
     *   PEXPLICIT_ACCESS *pListOfExplicitEntries)
     *
     * One EXPLICIT_ACCESS per ACE naming a trustee, in the ACL's order, in
     * one LocalAlloc block with the SIDs behind the entries; none is a NULL
     * list. The answer is the error code.
     *
     * @param {boolean} wide  The two lay out the same: the trustee is a SID.
     */
    const explicitEntries = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [acl, count, out])=>{
            void wide;
            const aces = acesIn(aclAt(acl) ?? new Uint8Array(0));
            if (aces === null || (count >>> 0) === 0 || (out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const modes = new Map([[ACCESS_ALLOWED_ACE_TYPE, GRANT_ACCESS],
                [ACCESS_DENIED_ACE_TYPE, DENY_ACCESS]]);
            const entries = aces.filter(ace=>ace.sid !== null
                && (modes.has(ace.type) || ace.type === SYSTEM_AUDIT_ACE_TYPE));
            writeDword(count, entries.length);
            if (entries.length === 0)
            {
                writeDword(out, 0);
                return ERROR_SUCCESS;
            }
            const sidsAt = entries.length * EXPLICIT_ACCESS_SIZE;
            const size = sidsAt + entries.reduce((sum, ace)=>sum + (ace.sid?.length ?? 0), 0);
            const block = host.allocate(size);
            const bytes = new Uint8Array(size);
            const view = new DataView(bytes.buffer);
            let sidAtOffset = sidsAt;
            entries.forEach((ace, index)=>{
                const sid = /** @type {Uint8Array} */ (ace.sid);
                const at = index * EXPLICIT_ACCESS_SIZE;
                const mode = modes.get(ace.type)
                    ?? ((ace.flags & FAILED_ACCESS_ACE_FLAG) !== 0
                        && (ace.flags & SUCCESSFUL_ACCESS_ACE_FLAG) === 0
                        ? SET_AUDIT_FAILURE : SET_AUDIT_SUCCESS);
                view.setUint32(at, ace.mask, true);
                view.setUint32(at + 4, mode, true);
                view.setUint32(at + 8, ace.flags & VALID_INHERIT_FLAGS & ~INHERITED_ACE, true);
                view.setUint32(at + 12 + TRUSTEE.FORM, TRUSTEE_IS_SID, true);
                view.setUint32(at + 12 + TRUSTEE.TYPE, TRUSTEE_IS_UNKNOWN, true);
                view.setUint32(at + 12 + TRUSTEE.NAME, block + sidAtOffset, true);
                bytes.set(sid, sidAtOffset);
                sidAtOffset += sid.length;
            });
            host.writeMemory(block, bytes);
            writeDword(out, block);
            return ERROR_SUCCESS;
        },
    });

    /**
     * void SetSecurityDescriptorSacl / BOOL: the SACL's pointer and its two
     * bits, on an absolute descriptor; a self-relative one cannot take a
     * pointer.
     */
    const setSecurityDescriptorSacl = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [descriptor, present, acl, defaulted])=>{
            if ((descriptor >>> 0) === 0 || host.readMemory(descriptor >>> 0, 1)[0] !== 1)
            {
                return fail(ERROR_INVALID_SECURITY_DESCR);
            }
            let control = readWord((descriptor >>> 0) + SD.CONTROL);
            if ((control & SE_SELF_RELATIVE) !== 0)
            {
                return fail(ERROR_INVALID_SECURITY_DESCR);
            }
            control &= ~(SE_SACL_PRESENT | SE_SACL_DEFAULTED);
            if (present !== 0)
            {
                control |= SE_SACL_PRESENT | (defaulted !== 0 ? SE_SACL_DEFAULTED : 0);
                writeDword((descriptor >>> 0) + SD.SACL, acl);
            }
            writeWord((descriptor >>> 0) + SD.CONTROL, control);
            return 1;
        },
    };

    /** @param {number} field  A TRUSTEE's field, read as it is. */
    const trusteeField = field=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([trustee])=>readDword(trustee + field),
    });

    /** The next LUID AllocateLocallyUniqueId hands out: above every privilege's. */
    let nextLuid = 0x10000;

    return {
        /** DWORD GetSidLengthRequired(UCHAR nSubAuthorityCount) */
        GetSidLengthRequired: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([count])=>8 + 4 * (count & 0xff),
        },

        /**
         * BOOL InitializeSid(PSID Sid, PSID_IDENTIFIER_AUTHORITY, BYTE nSubAuthorityCount)
         *
         * The header only: the sub-authorities are the caller's to write.
         */
        InitializeSid: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([sid, authority, count])=>{
                if ((count & 0xff) > 15)
                {
                    return 0;
                }
                const head = new Uint8Array(8);
                head[0] = 1;
                head[1] = count & 0xff;
                head.set(host.readMemory(authority >>> 0, 6), 2);
                host.writeMemory(sid >>> 0, head);
                return 1;
            },
        },

        /**
         * BOOL EqualPrefixSid(PSID pSid1, PSID pSid2)
         *
         * The same but for the last sub-authority: the same revision, count
         * and authority, and every sub-authority before the last.
         */
        EqualPrefixSid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const left = sidAt(first);
                const right = sidAt(second);
                if (!left || !right || left[1] !== right[1])
                {
                    host.setLastError(ERROR_SUCCESS);
                    return 0;
                }
                const prefix = left[1] === 0 ? 8 : 8 + 4 * (left[1] - 1);
                host.setLastError(ERROR_SUCCESS);
                return sameBytes(left.subarray(0, prefix), right.subarray(0, prefix)) ? 1 : 0;
            },
        },

        /**
         * BOOL EqualDomainSid(PSID pSid1, PSID pSid2, BOOL *pfEqual)
         *
         * Whether two SIDs are of one domain -- the built-in one, or an
         * account domain; a SID in neither is ERROR_NON_DOMAIN_SID.
         */
        EqualDomainSid: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([first, second, out])=>{
                const left = sidAt(first);
                const right = sidAt(second);
                if (!left || !right)
                {
                    return fail(ERROR_INVALID_SID);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const leftDomain = domainOf(left);
                const rightDomain = domainOf(right);
                if (leftDomain === null || rightDomain === null)
                {
                    return fail(ERROR_NON_DOMAIN_SID);
                }
                writeDword(out, sameBytes(leftDomain, rightDomain) ? 1 : 0);
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * BOOL GetWindowsAccountDomainSid(PSID pSid, PSID pDomainSid, DWORD *cbDomainSid)
         *
         * S-1-5-21 and the three numbers after it, for a SID of an account
         * domain; the size needed is answered before the buffer is looked at.
         */
        GetWindowsAccountDomainSid: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([sid, out, size])=>{
                const held = sidAt(sid);
                if (!held)
                {
                    return fail(ERROR_INVALID_SID);
                }
                if ((size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const domain = domainOf(held);
                if (domain === null || domain[1] !== 4)
                {
                    return fail(ERROR_NON_ACCOUNT_SID);
                }
                const room = readDword(size);
                writeDword(size, domain.length);
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (room < domain.length)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(out >>> 0, domain);
                return 1;
            },
        },

        /**
         * BOOL CreateWellKnownSid(WELL_KNOWN_SID_TYPE, PSID DomainSid, PSID pSid,
         *   DWORD *cbSid)
         *
         * The SID a type names; one relative to a domain takes the domain
         * given and its RID, the rest ignore it. The size is checked before
         * the buffer, so a NULL buffer with too small a size learns it.
         */
        CreateWellKnownSid: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([type, domain, out, size])=>{
                const text = WELL_KNOWN_SIDS[type >>> 0] ?? null;
                if (text === null || (size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const sid = wellKnownSid(text, sidAt(domain));
                if (sid === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const room = readDword(size);
                if (room < sid.length)
                {
                    writeDword(size, sid.length);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                host.writeMemory(out >>> 0, sid);
                writeDword(size, sid.length);
                return 1;
            },
        },

        /**
         * BOOL IsWellKnownSid(PSID pSid, WELL_KNOWN_SID_TYPE WellKnownSidType)
         *
         * A type relative to a domain matches its RID after any account
         * domain's three numbers.
         */
        IsWellKnownSid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([sid, type])=>{
                const held = sidAt(sid);
                if (held && (type >>> 0) === WinLogonIdsSid)
                {
                    // S-1-5-5-X-Y: a logon session's, whichever session it is.
                    const view = new DataView(held.buffer);
                    return held[1] === 3 && view.getUint16(2) === 0 && view.getUint32(4) === 5
                        && view.getUint32(8, true) === 5 ? 1 : 0;
                }
                const text = WELL_KNOWN_SIDS[type >>> 0] ?? null;
                if (!held || text === null)
                {
                    return 0;
                }
                if (text.startsWith('D-'))
                {
                    const domain = domainOf(held);
                    return domain !== null && domain[1] === 4 && held[1] === 5
                        && new DataView(held.buffer).getUint32(8 + 16, true)
                            === Number(text.slice(2)) ? 1 : 0;
                }
                return sameBytes(held, /** @type {Uint8Array} */ (wellKnownSid(text, null)))
                    ? 1 : 0;
            },
        },

        /**
         * BOOL AllocateLocallyUniqueId(PLUID Luid)
         *
         * A number no other call of this process has been given, and none of
         * the privileges' -- they are LUIDs too.
         */
        AllocateLocallyUniqueId: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_NOACCESS);
                }
                writeDword(out, nextLuid++);
                writeDword((out >>> 0) + 4, 0);
                return 1;
            },
        },

        LookupPrivilegeNameA: lookupPrivilegeName(false),
        LookupPrivilegeNameW: lookupPrivilegeName(true),

        BuildTrusteeWithSidA: buildTrustee(TRUSTEE_IS_SID),
        BuildTrusteeWithSidW: buildTrustee(TRUSTEE_IS_SID),
        BuildTrusteeWithNameA: buildTrustee(TRUSTEE_IS_NAME),
        BuildTrusteeWithNameW: buildTrustee(TRUSTEE_IS_NAME),
        BuildTrusteeWithObjectsAndSidA: buildTrusteeWithObjectsAndSid,
        BuildTrusteeWithObjectsAndSidW: buildTrusteeWithObjectsAndSid,
        BuildTrusteeWithObjectsAndNameA: buildTrusteeWithObjectsAndName,
        BuildTrusteeWithObjectsAndNameW: buildTrusteeWithObjectsAndName,

        /**
         * LPTSTR GetTrusteeName(PTRUSTEE), TRUSTEE_FORM GetTrusteeForm(PTRUSTEE),
         * TRUSTEE_TYPE GetTrusteeType(PTRUSTEE): the fields as they are.
         */
        GetTrusteeNameA: trusteeField(TRUSTEE.NAME),
        GetTrusteeNameW: trusteeField(TRUSTEE.NAME),
        GetTrusteeFormA: trusteeField(TRUSTEE.FORM),
        GetTrusteeFormW: trusteeField(TRUSTEE.FORM),
        GetTrusteeTypeA: trusteeField(TRUSTEE.TYPE),
        GetTrusteeTypeW: trusteeField(TRUSTEE.TYPE),

        /**
         * BOOL GetAclInformation(PACL pAcl, LPVOID pAclInformation,
         *   DWORD nAclInformationLength, ACL_INFORMATION_CLASS)
         *
         * The revision, or the count and the bytes used and free.
         */
        GetAclInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([acl, out, length, kind])=>{
                const bytes = aclAt(acl);
                const aces = bytes === null ? null : acesIn(bytes);
                if (bytes === null || aces === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((kind >>> 0) === AclRevisionInformation)
                {
                    if ((length >>> 0) < 4)
                    {
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    writeDword(out, bytes[0]);
                    return 1;
                }
                if ((kind >>> 0) === AclSizeInformation)
                {
                    if ((length >>> 0) < 12)
                    {
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    const used = aces.reduce((sum, ace)=>sum + ace.bytes.length, ACL_HEADER);
                    host.writeMemory(out >>> 0, new Uint8Array([...dwordBytes(aces.length),
                        ...dwordBytes(used), ...dwordBytes(bytes.length - used)]));
                    return 1;
                }
                return fail(ERROR_INVALID_PARAMETER);
            },
        },

        GetExplicitEntriesFromAclA: explicitEntries(false),
        GetExplicitEntriesFromAclW: explicitEntries(true),

        /**
         * BOOL SetSecurityDescriptorControl(PSECURITY_DESCRIPTOR,
         *   SECURITY_DESCRIPTOR_CONTROL ControlBitsOfInterest,
         *   SECURITY_DESCRIPTOR_CONTROL ControlBitsToSet)
         *
         * The bits of interest set or cleared as asked; a bit either word
         * names that only the setters and the form decide is refused, and
         * nothing is changed.
         */
        SetSecurityDescriptorControl: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([descriptor, interest, set])=>{
                if ((descriptor >>> 0) === 0 || host.readMemory(descriptor >>> 0, 1)[0] !== 1)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                if (((interest | set) & 0xffff & IMMUTABLE_CONTROL) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const control = readWord((descriptor >>> 0) + SD.CONTROL);
                writeWord((descriptor >>> 0) + SD.CONTROL,
                    (control & ~interest | set & interest) & 0xffff);
                return 1;
            },
        },

        SetSecurityDescriptorSacl: setSecurityDescriptorSacl,

        /**
         * BOOL MakeSelfRelativeSD(PSECURITY_DESCRIPTOR pAbsoluteSD,
         *   PSECURITY_DESCRIPTOR pSelfRelativeSD, LPDWORD lpdwBufferLength)
         *
         * The parts gathered behind the header; too small a buffer is told
         * the size, a fit leaves the length as it was. A descriptor already
         * self-relative is not one to make so.
         */
        MakeSelfRelativeSD: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([absolute, out, size])=>{
                const parts = partsOf(absolute);
                if (parts === null)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                if ((parts.control & SE_SELF_RELATIVE) !== 0)
                {
                    return fail(ERROR_BAD_DESCRIPTOR_FORMAT);
                }
                const bytes = selfRelative(parts);
                if ((size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (readDword(size) < bytes.length || (out >>> 0) === 0)
                {
                    writeDword(size, bytes.length);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(out >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL MakeAbsoluteSD(PSECURITY_DESCRIPTOR pSelfRelativeSD,
         *   PSECURITY_DESCRIPTOR pAbsoluteSD, LPDWORD lpdwAbsoluteSDSize,
         *   PACL pDacl, LPDWORD lpdwDaclSize, PACL pSacl, LPDWORD lpdwSaclSize,
         *   PSID pOwner, LPDWORD lpdwOwnerSize, PSID pPrimaryGroup,
         *   LPDWORD lpdwPrimaryGroupSize)
         *
         * Each part into the buffer the caller gave for it, the header
         * pointing at them. When any buffer is too small every size is set to
         * what its part needs, and nothing is written.
         */
        MakeAbsoluteSD: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [relative, absolute, absoluteSize, dacl, daclSize,
                sacl, saclSize, owner, ownerSize, group, groupSize])=>{
                const parts = partsOf(relative);
                if (parts === null)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                if ((parts.control & SE_SELF_RELATIVE) === 0)
                {
                    return fail(ERROR_BAD_DESCRIPTOR_FORMAT);
                }
                const wanted = [
                    [absoluteSize, SD.SIZE], [daclSize, parts.dacl?.length ?? 0],
                    [saclSize, parts.sacl?.length ?? 0], [ownerSize, parts.owner?.length ?? 0],
                    [groupSize, parts.group?.length ?? 0],
                ];
                if (wanted.some(([size])=>(size >>> 0) === 0))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (wanted.some(([size, need])=>readDword(size) < need)
                    || (absolute >>> 0) === 0)
                {
                    for (const [size, need] of wanted)
                    {
                        writeDword(size, need);
                    }
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                /** @param {Uint8Array | null | undefined} part @param {number} at */
                const place = (part, at)=>{
                    if (!part)
                    {
                        return 0;
                    }
                    host.writeMemory(at >>> 0, part);
                    return at >>> 0;
                };
                const header = new Uint8Array(SD.SIZE);
                const view = new DataView(header.buffer);
                header[0] = 1;
                view.setUint16(SD.CONTROL, parts.control & ~SE_SELF_RELATIVE, true);
                view.setUint32(SD.OWNER, place(parts.owner, owner), true);
                view.setUint32(SD.GROUP, place(parts.group, group), true);
                view.setUint32(SD.SACL, place(parts.sacl, sacl), true);
                view.setUint32(SD.DACL, place(parts.dacl, dacl), true);
                host.writeMemory(absolute >>> 0, header);
                return 1;
            },
        },

        /**
         * BOOL GetPrivateObjectSecurity(PSECURITY_DESCRIPTOR ObjectDescriptor,
         *   SECURITY_INFORMATION, PSECURITY_DESCRIPTOR ResultantDescriptor,
         *   DWORD DescriptorLength, PDWORD ReturnLength)
         *
         * The parts asked for, self-relative; too small a buffer is told the
         * size needed.
         */
        GetPrivateObjectSecurity: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([descriptor, wanted, out, length, needed])=>{
                const parts = partsOf(descriptor);
                if (parts === null)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                const bytes = selfRelative(partsAskedFor(parts, wanted));
                if ((needed >>> 0) !== 0)
                {
                    writeDword(needed, bytes.length);
                }
                if ((length >>> 0) < bytes.length || (out >>> 0) === 0)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(out >>> 0, bytes);
                return 1;
            },
        },

        /**
         * DWORD BuildSecurityDescriptor(PTRUSTEE pOwner, PTRUSTEE pGroup,
         *   ULONG cCountOfAccessEntries, PEXPLICIT_ACCESS pListOfAccessEntries,
         *   ULONG cCountOfAuditEntries, PEXPLICIT_ACCESS pListOfAuditEntries,
         *   PSECURITY_DESCRIPTOR pOldSD, PULONG pSizeNewSD, PSECURITY_DESCRIPTOR *pNewSD)
         *
         * A self-relative descriptor in a LocalAlloc block: the old one's
         * parts -- which must be self-relative -- with the owner and group
         * given by SID over them. The answer is the error code.
         */
        BuildSecurityDescriptorA: buildSecurityDescriptor(),
        BuildSecurityDescriptorW: buildSecurityDescriptor(),

        ConvertSecurityDescriptorToStringSecurityDescriptorA: descriptorToString(false),
        ConvertSecurityDescriptorToStringSecurityDescriptorW: descriptorToString(true),
    };

    function buildSecurityDescriptor(){
        return {
            argBytes: 36,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [owner, group, , , , , old, size, out])=>{
                if ((out >>> 0) === 0 || (size >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                /** @type {import('./descriptors.js').DescriptorParts} */
                let parts = { control: 0 };
                if ((old >>> 0) !== 0)
                {
                    const held = partsOf(old);
                    if (held === null || (held.control & SE_SELF_RELATIVE) === 0)
                    {
                        return ERROR_INVALID_SECURITY_DESCR;
                    }
                    parts = held;
                }
                for (const [trustee, name] of /** @type {const} */ ([[owner, 'owner'],
                    [group, 'group']]))
                {
                    if ((trustee >>> 0) === 0)
                    {
                        continue;
                    }
                    const sid = readDword(trustee + TRUSTEE.FORM) === TRUSTEE_IS_SID
                        ? sidAt(readDword(trustee + TRUSTEE.NAME)) : null;
                    if (sid === null)
                    {
                        return ERROR_INVALID_PARAMETER;
                    }
                    parts[name] = sid;
                }
                const bytes = selfRelative(parts);
                const block = host.allocate(bytes.length);
                host.writeMemory(block, bytes);
                writeDword(size, bytes.length);
                writeDword(out, block);
                return ERROR_SUCCESS;
            },
        };
    }
}
