/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The security of an object named by its path or by its key's name:
 * GetNamedSecurityInfo and SetNamedSecurityInfo, which an installer calls to
 * read a folder's or a key's DACL, merge entries into it and set it back.
 *
 * The volume keeps no security descriptors, and says so: GetVolumeInformation
 * reports no FILE_PERSISTENT_ACLS. So a file is answered as Windows answers
 * for a file system that keeps none, FAT32: the world descriptor the I/O
 * manager makes up for it -- owned by Everyone, its group Everyone, its DACL
 * present and null. A null DACL rather than one granting Everyone full access,
 * because a null DACL is what such a volume answers: a program merging its
 * entries into the DACL it read starts from nothing, as it would there, and
 * one checking whether everyone may write learns that they may. Setting a
 * file's security succeeds and is kept nowhere, as on such a volume.
 *
 * A registry key is answered in the shape Windows gives its own keys, which
 * its own tests check: owned by BUILTIN\Administrators, its group the local
 * system, its DACL reading for the users and everything for the
 * administrators and the system. Nothing here enforces it -- the one account
 * is an administrator -- and setting it is accepted and kept nowhere.
 *
 * Both calls answer their error as the return value and leave the last error
 * alone, as Windows' own tests see SetNamedSecurityInfo do.
 */

import {
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS,
} from './registry.js';
import {
    WELL_KNOWN_SIDS, aceBytes, aclBytes, selfRelativeDescriptor, sidBytes, wideTextAt,
} from './tokens.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INVALID_ACL = 1336;
const ERROR_INVALID_SID = 1337;

/** SE_OBJECT_TYPE: what kind of object a name names. */
const SE_FILE_OBJECT = 1;
const SE_REGISTRY_KEY = 4;
const SE_REGISTRY_WOW64_32KEY = 12;

/** SECURITY_INFORMATION: the parts of a descriptor asked for or given. */
const OWNER_SECURITY_INFORMATION = 0x1;
const GROUP_SECURITY_INFORMATION = 0x2;
const DACL_SECURITY_INFORMATION = 0x4;
const SACL_SECURITY_INFORMATION = 0x8;

/** The revisions an ACL is made with: ACL_REVISION through ACL_REVISION_DS. */
const ACL_REVISIONS = new Set([2, 3, 4]);
const ACL_HEADER = 8;

/** The roots a key's name begins with, as these calls spell them. */
const REGISTRY_ROOTS = new Map([
    ['CLASSES_ROOT', HKEY_CLASSES_ROOT], ['CURRENT_USER', HKEY_CURRENT_USER],
    ['MACHINE', HKEY_LOCAL_MACHINE], ['USERS', HKEY_USERS],
]);

/** Longer than any path or key name a program could mean. */
const MAX_NAME = 0x8000;

const ACCESS_ALLOWED_ACE_TYPE = 0;
const CONTAINER_INHERIT_ACE = 0x2;
const KEY_READ = 0x20019;
const KEY_ALL_ACCESS = 0xf003f;

/**
 * An allowed ACE the key's subkeys inherit.
 *
 * @param {import('./tokens.js').Sid} sid @param {number} mask
 */
const keyAce = (sid, mask)=>aceBytes(ACCESS_ALLOWED_ACE_TYPE, CONTAINER_INHERIT_ACE, mask,
    sidBytes(sid));

/** A key's DACL: reading for the users, everything for the administrators and the system. */
const KEY_DACL = aclBytes([
    keyAce(WELL_KNOWN_SIDS.users, KEY_READ),
    keyAce(WELL_KNOWN_SIDS.administrators, KEY_ALL_ACCESS),
    keyAce(WELL_KNOWN_SIDS.system, KEY_ALL_ACCESS),
]);

/**
 * The directory a path is in, or null for a bare name, which is in the
 * current one. A drive's root keeps its backslash: "C:" alone names the
 * current directory of the drive, not its root.
 *
 * @param {string} path
 */
const parentOf = path=>{
    const trimmed = path.replace(/[\\/]+$/, '');
    const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (at < 0)
    {
        return null;
    }
    const parent = trimmed.slice(0, at);
    return parent === '' || /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
};

/**
 * @typedef {Object} NamedSecurityHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} [allocate]  LocalFree-compatible: where a
 *           descriptor is handed out. Without it a read fails as out of memory.
 * @property {{ stat: (path: string) => { exists: boolean, isDirectory: boolean } | null }}
 *           [files]  The volume. Without it no file is found.
 * @property {{ root: (root: number) => number | null,
 *              open: (key: number, path?: string | null) => number | null }} hive
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {NamedSecurityHost} host
 */
export function createNamedSecurityFunctions(host){
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * Whether a path names something on the volume, and if not, why: the
     * file is not there, or the directory it would be in is not either.
     *
     * @param {string} path @returns {number}
     */
    const findFile = path=>{
        if (!host.files)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        if (host.files.stat(path)?.exists)
        {
            return ERROR_SUCCESS;
        }
        const parent = parentOf(path);
        return parent !== null && !host.files.stat(parent)?.isDirectory
            ? ERROR_PATH_NOT_FOUND : ERROR_FILE_NOT_FOUND;
    };

    /**
     * Whether a key's name -- a root's name, then the path under it -- names
     * a key in the hive.
     *
     * @param {string} name @returns {number}
     */
    const findKey = name=>{
        const at = name.indexOf('\\');
        const root = REGISTRY_ROOTS.get((at < 0 ? name : name.slice(0, at)).toUpperCase());
        if (root === undefined)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const key = host.hive.root(root);
        const found = key === null ? null : host.hive.open(key, at < 0 ? null : name.slice(at + 1));
        return found === null ? ERROR_FILE_NOT_FOUND : ERROR_SUCCESS;
    };

    /**
     * The kind of object a name names, or the error that says there is none.
     * The kinds of object this machine keeps nothing about by name -- a
     * service, a printer, a share, a kernel object -- are reported and
     * answered as not implemented, which a caller can tell from "not there".
     *
     * @param {string} api @param {number} pointer @param {number} type @param {boolean} wide
     * @returns {'file' | 'key' | number}
     */
    const objectOf = (api, pointer, type, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const name = wide ? wideTextAt(host.readMemory, pointer, MAX_NAME)
            : host.readCString(pointer >>> 0, MAX_NAME);
        switch (type >>> 0)
        {
            case SE_FILE_OBJECT:
            {
                const error = findFile(name);
                return error === ERROR_SUCCESS ? 'file' : error;
            }
            case SE_REGISTRY_KEY:
            case SE_REGISTRY_WOW64_32KEY:
            {
                const error = findKey(name);
                return error === ERROR_SUCCESS ? 'key' : error;
            }
            default:
                if ((type >>> 0) === 0 || (type >>> 0) > SE_REGISTRY_WOW64_32KEY)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.divergence?.(api, `object type ${type >>> 0} has no security by name here`);
                return ERROR_CALL_NOT_IMPLEMENTED;
        }
    };

    /**
     * The descriptor an object has, with the parts asked for.
     *
     * @param {'file' | 'key'} kind @param {number} wanted
     */
    const descriptorOf = (kind, wanted)=>{
        /** @param {number} bit */
        const asked = bit=>(wanted & bit) !== 0;
        if (kind === 'file')
        {
            const world = sidBytes(WELL_KNOWN_SIDS.everyone);
            return selfRelativeDescriptor({
                ...asked(OWNER_SECURITY_INFORMATION) ? { owner: world } : {},
                ...asked(GROUP_SECURITY_INFORMATION) ? { group: world } : {},
                ...asked(DACL_SECURITY_INFORMATION) ? { dacl: null } : {},
                ...asked(SACL_SECURITY_INFORMATION) ? { sacl: null } : {},
            });
        }
        return selfRelativeDescriptor({
            ...asked(OWNER_SECURITY_INFORMATION)
                ? { owner: sidBytes(WELL_KNOWN_SIDS.administrators) } : {},
            ...asked(GROUP_SECURITY_INFORMATION) ? { group: sidBytes(WELL_KNOWN_SIDS.system) } : {},
            ...asked(DACL_SECURITY_INFORMATION) ? { dacl: KEY_DACL } : {},
        });
    };

    /**
     * DWORD GetNamedSecurityInfo(LPCTSTR pObjectName, SE_OBJECT_TYPE ObjectType,
     *   SECURITY_INFORMATION SecurityInfo, PSID *ppsidOwner, PSID *ppsidGroup,
     *   PACL *ppDacl, PACL *ppSacl, PSECURITY_DESCRIPTOR *ppSecurityDescriptor)
     *
     * The descriptor, self-relative, in a LocalAlloc block the caller frees;
     * the part pointers point into it, and one for a part that is not there
     * -- a null DACL -- is NULL. Without the descriptor's pointer, every part
     * asked for needs one of its own and at least one must be given, which
     * is what Windows' own tests see refused.
     *
     * @param {boolean} wide
     */
    const getNamedSecurityInfo = wide=>({
        argBytes: 32,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [name, type, wanted, owner, group, dacl, sacl,
            descriptor])=>{
            const outs = [[OWNER_SECURITY_INFORMATION, owner], [GROUP_SECURITY_INFORMATION, group],
                [DACL_SECURITY_INFORMATION, dacl], [SACL_SECURITY_INFORMATION, sacl]];
            if ((descriptor >>> 0) === 0 && (outs.every(([, out])=>(out >>> 0) === 0)
                || outs.some(([bit, out])=>(wanted & bit) !== 0 && (out >>> 0) === 0)))
            {
                return ERROR_INVALID_PARAMETER;
            }
            const kind = objectOf('GetNamedSecurityInfo', name, type, wide);
            if (typeof kind === 'number')
            {
                return kind;
            }
            if (!host.allocate)
            {
                return ERROR_NOT_ENOUGH_MEMORY;
            }
            const { bytes, offsets } = descriptorOf(kind, wanted >>> 0);
            const block = host.allocate(bytes.length);
            host.writeMemory(block, bytes);
            for (const [out, offset] of [[owner, offsets.owner], [group, offsets.group],
                [dacl, offsets.dacl], [sacl, offsets.sacl]])
            {
                if ((out >>> 0) !== 0)
                {
                    writeDword(out, offset === 0 ? 0 : block + offset);
                }
            }
            if ((descriptor >>> 0) !== 0)
            {
                writeDword(descriptor, block);
            }
            return ERROR_SUCCESS;
        },
    });

    /**
     * Whether what a caller passes as a part of a descriptor could be one: a
     * SID of revision 1 and no more sub-authorities than one holds, an ACL of
     * a revision there is and at least its header long. NULL is a part not
     * given, or the null DACL.
     *
     * @param {number} sid
     */
    const badSid = sid=>{
        if ((sid >>> 0) === 0)
        {
            return false;
        }
        const head = host.readMemory(sid >>> 0, 2);
        return head[0] !== 1 || head[1] > 15;
    };
    /** @param {number} acl */
    const badAcl = acl=>{
        if ((acl >>> 0) === 0)
        {
            return false;
        }
        const head = host.readMemory(acl >>> 0, 4);
        return !ACL_REVISIONS.has(head[0]) || (head[2] | head[3] << 8) < ACL_HEADER;
    };

    /**
     * DWORD SetNamedSecurityInfo(LPTSTR pObjectName, SE_OBJECT_TYPE ObjectType,
     *   SECURITY_INFORMATION SecurityInfo, PSID psidOwner, PSID psidGroup,
     *   PACL pDacl, PACL pSacl)
     *
     * The object has to be there, and the parts given have to be a SID or an
     * ACL; then the call succeeds and nothing is kept, so a read afterwards
     * answers what it answered before.
     *
     * @param {boolean} wide
     */
    const setNamedSecurityInfo = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [name, type, given, owner, group, dacl, sacl])=>{
            const kind = objectOf('SetNamedSecurityInfo', name, type, wide);
            if (typeof kind === 'number')
            {
                return kind;
            }
            if (((given & OWNER_SECURITY_INFORMATION) !== 0 && badSid(owner))
                || ((given & GROUP_SECURITY_INFORMATION) !== 0 && badSid(group)))
            {
                return ERROR_INVALID_SID;
            }
            if (((given & DACL_SECURITY_INFORMATION) !== 0 && badAcl(dacl))
                || ((given & SACL_SECURITY_INFORMATION) !== 0 && badAcl(sacl)))
            {
                return ERROR_INVALID_ACL;
            }
            return ERROR_SUCCESS;
        },
    });

    return {
        GetNamedSecurityInfoA: getNamedSecurityInfo(false),
        GetNamedSecurityInfoW: getNamedSecurityInfo(true),
        SetNamedSecurityInfoA: setNamedSecurityInfo(false),
        SetNamedSecurityInfoW: setNamedSecurityInfo(true),
    };
}
