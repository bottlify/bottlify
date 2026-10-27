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
 * The volume is NTFS and keeps security descriptors, as GetVolumeInformation
 * says with FILE_PERSISTENT_ACLS. So a file's security is answered the way
 * NTFS answers for one that inherited nothing and had none set -- full
 * control to the administrators, the system and the owner -- until a program
 * sets one, and what it sets is kept and answered back. The descriptors are
 * the run's, not a process's (a setup writes one and a service reads it in
 * another process of the one run), so they live in a store beside the hive
 * for the run's lifetime; nothing is written to the volume, so a later run
 * starts fresh. This replaces decision A34, whose FAT32 null DACL a setup
 * that read a folder's DACL, merged an entry and wrote it back could not see
 * take; see roadmap/decisions.md.
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
import { createDescriptorCodec } from './descriptors.js';

/** Where the file-security record hook sits in the table, past the named exports. */
export const RECORD_SECURITY = Symbol('recordSecurity');

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INVALID_ACL = 1336;
const ERROR_INVALID_SID = 1337;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_SECURITY_DESCR = 1338;

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
const OBJECT_INHERIT_ACE = 0x1;
const CONTAINER_INHERIT_ACE = 0x2;
const INHERITED_ACE = 0x10;
const KEY_READ = 0x20019;
const KEY_ALL_ACCESS = 0xf003f;
/** FILE_ALL_ACCESS, and the generic rights a file maps to read/write/execute/all. */
const FILE_ALL_ACCESS = 0x1f01ff;
const FILE_GENERIC = [0x120089, 0x120116, 0x1200a0, FILE_ALL_ACCESS];
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const GENERIC_EXECUTE = 0x20000000;
const GENERIC_ALL = 0x10000000;

/**
 * The generic rights of a mask turned into a file's specific ones, the
 * generic bits themselves dropped: what GetNamedSecurityInfo answers for an
 * ACE a program set with GENERIC_ALL.
 *
 * @param {number} mask
 */
const toFileMask = mask=>{
    let mapped = mask & ~(GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | GENERIC_ALL);
    [GENERIC_READ, GENERIC_WRITE, GENERIC_EXECUTE, GENERIC_ALL].forEach((bit, at)=>{
        if ((mask & bit) !== 0)
        {
            mapped |= FILE_GENERIC[at];
        }
    });
    return mapped >>> 0;
};

/** CREATOR OWNER, S-1-3-0: the placeholder an inherited ACE names for whoever owns the child. */
const CREATOR_OWNER = { authority: 3, subAuthorities: [0] };

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
 * The DACL an NTFS volume gives a file or directory that inherited nothing
 * and had none set: full control to the administrators, the system and the
 * owner, as Windows lays a fresh volume's out. A directory's ACEs are
 * inheritable; a file's are marked inherited.
 *
 * @param {boolean} directory
 */
const defaultFileDacl = directory=>{
    const flags = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : INHERITED_ACE;
    return aclBytes([WELL_KNOWN_SIDS.administrators, WELL_KNOWN_SIDS.system, CREATOR_OWNER]
        .map(sid=>aceBytes(ACCESS_ALLOWED_ACE_TYPE, flags, FILE_ALL_ACCESS, sidBytes(sid))));
};

/** @param {string} path  The path a descriptor is kept under, forward slashes folded. */
const keyForPath = path=>path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/**
 * Each ACE of an ACL with its mask mapped from the generic rights to a
 * file's, so a DACL set with GENERIC_ALL reads back as FILE_ALL_ACCESS.
 *
 * @param {Uint8Array} acl @returns {Uint8Array} the ACL rebuilt
 */
const fileMappedAcl = acl=>{
    const view = new DataView(acl.buffer, acl.byteOffset, acl.length);
    const count = view.getUint16(4, true);
    const aces = [];
    let at = 8;
    for (let index = 0; index < count && at + 8 <= acl.length; index++)
    {
        const size = view.getUint16(at + 2, true);
        const ace = acl.slice(at, at + size).slice();
        new DataView(ace.buffer).setUint32(4, toFileMask(view.getUint32(at + 4, true)), true);
        aces.push(ace);
        at += size;
    }
    return aclBytes(aces, acl[0]);
};

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
 * @property {Map<string, { owner?: Uint8Array, group?: Uint8Array,
 *              dacl?: Uint8Array | null }>} [security]
 *           The run's store of the descriptors programs set on files, by path,
 *           shared by every process of the run. Without it a set is kept
 *           nowhere and a read answers the volume's made-up descriptor.
 * @property {(path: string) => string} [resolvePath]  A path made absolute, to key the store by.
 * @property {(path: string) => void} [dropSecurity]  Drops a path's entry on delete.
 * @property {(from: string, to: string) => void} [moveSecurity]  Moves it on rename.
 * @property {(code: number) => void} [setLastError]  For the BOOL file-security calls.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {NamedSecurityHost} host
 */
export function createNamedSecurityFunctions(host){
    const codec = createDescriptorCodec(host.readMemory);
    /** The run's file-security store; a private one when the run shares none. */
    const store = host.security ?? new Map();

    /** @param {string} path */
    const pathKey = path=>keyForPath(host.resolvePath?.(path) ?? path);

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
     * @returns {{ kind: 'file' | 'key', name: string } | number}
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
                return error === ERROR_SUCCESS ? { kind: /** @type {const} */ ('file'), name }
                    : error;
            }
            case SE_REGISTRY_KEY:
            case SE_REGISTRY_WOW64_32KEY:
            {
                const error = findKey(name);
                return error === ERROR_SUCCESS ? { kind: /** @type {const} */ ('key'), name }
                    : error;
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
     * The descriptor an object has, with the parts asked for. A file's is
     * what a program set on it, kept in the store, or -- having set none --
     * the NTFS volume's: owned by the administrators, its group the system,
     * its DACL full control to the administrators, the system and the owner.
     * A directory's DACL is inheritable, a file's inherited, and a mask set
     * with the generic rights reads back as a file's specific ones.
     *
     * @param {'file' | 'key'} kind @param {string} name @param {number} wanted
     */
    const descriptorOf = (kind, name, wanted)=>{
        /** @param {number} bit */
        const asked = bit=>(wanted & bit) !== 0;
        if (kind === 'file')
        {
            const held = store.get(pathKey(name));
            const directory = host.files?.stat(name)?.isDirectory === true;
            const dacl = held && 'dacl' in held
                ? (held.dacl ? fileMappedAcl(held.dacl) : null)
                : defaultFileDacl(directory);
            return selfRelativeDescriptor({
                ...asked(OWNER_SECURITY_INFORMATION)
                    ? { owner: held?.owner ?? sidBytes(WELL_KNOWN_SIDS.administrators) } : {},
                ...asked(GROUP_SECURITY_INFORMATION)
                    ? { group: held?.group ?? sidBytes(WELL_KNOWN_SIDS.system) } : {},
                ...asked(DACL_SECURITY_INFORMATION) ? { dacl } : {},
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
     * Keeps on a file's path the parts a program set, for the run: the SIDs
     * and the DACL it gave, each only where its bit is in `given`. A key's are
     * taken and kept nowhere, as the one account enforces nothing.
     *
     * @param {string} name @param {number} given @param {number} owner @param {number} group
     * @param {number} dacl
     */
    const keepFileSecurity = (name, given, owner, group, dacl)=>{
        const held = { ...store.get(pathKey(name)) };
        if ((given & OWNER_SECURITY_INFORMATION) !== 0)
        {
            const sid = codec.sidAt(owner);
            if (sid)
            {
                held.owner = sid;
            }
        }
        if ((given & GROUP_SECURITY_INFORMATION) !== 0)
        {
            const sid = codec.sidAt(group);
            if (sid)
            {
                held.group = sid;
            }
        }
        if ((given & DACL_SECURITY_INFORMATION) !== 0)
        {
            if ((dacl >>> 0) === 0)
            {
                held.dacl = null;
            }
            else
            {
                const head = host.readMemory(dacl >>> 0, 4);
                const size = head[2] | head[3] << 8;
                held.dacl = host.readMemory(dacl >>> 0, size).slice();
            }
        }
        store.set(pathKey(name), held);
    };

    /**
     * Keeps the parts a descriptor holds -- owner, group and a present DACL,
     * each only where its bit is in `given` -- on a file's path.
     *
     * @param {string} name @param {number} given
     * @param {import('./descriptors.js').DescriptorParts} parts
     */
    const recordDescriptor = (name, given, parts)=>{
        const held = { ...store.get(pathKey(name)) };
        if ((given & OWNER_SECURITY_INFORMATION) !== 0 && parts.owner)
        {
            held.owner = parts.owner;
        }
        if ((given & GROUP_SECURITY_INFORMATION) !== 0 && parts.group)
        {
            held.group = parts.group;
        }
        if ((given & DACL_SECURITY_INFORMATION) !== 0 && parts.dacl !== undefined)
        {
            held.dacl = parts.dacl;
        }
        store.set(pathKey(name), held);
    };

    /** @param {number} code @returns {0} fails a BOOL call with a last error */
    const setError = code=>{
        host.setLastError?.(code);
        return 0;
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
            const object = objectOf('GetNamedSecurityInfo', name, type, wide);
            if (typeof object === 'number')
            {
                return object;
            }
            if (!host.allocate)
            {
                return ERROR_NOT_ENOUGH_MEMORY;
            }
            const { bytes, offsets } = descriptorOf(object.kind, object.name, wanted >>> 0);
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
            const object = objectOf('SetNamedSecurityInfo', name, type, wide);
            if (typeof object === 'number')
            {
                return object;
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
            if (object.kind === 'file')
            {
                keepFileSecurity(object.name, given >>> 0, owner, group, dacl);
            }
            return ERROR_SUCCESS;
        },
    });

    /**
     * BOOL GetFileSecurity(LPCTSTR lpFileName, SECURITY_INFORMATION RequestedInformation,
     *   PSECURITY_DESCRIPTOR pSecurityDescriptor, DWORD nLength, LPDWORD lpnLengthNeeded)
     *
     * The file's descriptor, self-relative, into the caller's own buffer by
     * the size convention; the parts are the same GetNamedSecurityInfo gives.
     *
     * @param {boolean} wide
     */
    const getFileSecurity = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [name, wanted, descriptor, length, needed])=>{
            const object = objectOf('GetFileSecurity', name, SE_FILE_OBJECT, wide);
            if (typeof object === 'number')
            {
                return setError(object);
            }
            const { bytes } = descriptorOf('file', object.name, wanted >>> 0);
            if ((needed >>> 0) !== 0)
            {
                writeDword(needed, bytes.length);
            }
            if ((length >>> 0) < bytes.length || (descriptor >>> 0) === 0)
            {
                return setError(ERROR_INSUFFICIENT_BUFFER);
            }
            host.writeMemory(descriptor >>> 0, bytes);
            return 1;
        },
    });

    /**
     * BOOL SetFileSecurity(LPCTSTR lpFileName, SECURITY_INFORMATION SecurityInformation,
     *   PSECURITY_DESCRIPTOR pSecurityDescriptor)
     *
     * The parts the information names, taken from the descriptor, kept on the
     * file's path for the run.
     *
     * @param {boolean} wide
     */
    const setFileSecurity = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [name, given, descriptor])=>{
            const object = objectOf('SetFileSecurity', name, SE_FILE_OBJECT, wide);
            if (typeof object === 'number')
            {
                return setError(object);
            }
            const parts = codec.partsOf(descriptor);
            if (parts === null)
            {
                return setError(ERROR_INVALID_SECURITY_DESCR);
            }
            recordDescriptor(object.name, given >>> 0, parts);
            return 1;
        },
    });

    return {
        GetNamedSecurityInfoA: getNamedSecurityInfo(false),
        GetNamedSecurityInfoW: getNamedSecurityInfo(true),
        SetNamedSecurityInfoA: setNamedSecurityInfo(false),
        SetNamedSecurityInfoW: setNamedSecurityInfo(true),
        GetFileSecurityA: getFileSecurity(false),
        GetFileSecurityW: getFileSecurity(true),
        SetFileSecurityA: setFileSecurity(false),
        SetFileSecurityW: setFileSecurity(true),
        /**
         * Keeps the descriptor CreateFile or CreateDirectory was given, as
         * SetFileSecurity keeps one: the owner, group and DACL it holds, under
         * the new object's path. Nothing when no descriptor was passed.
         *
         * @param {string} path @param {number} sd  The SECURITY_DESCRIPTOR, or 0.
         */
        [RECORD_SECURITY]: (path, sd)=>{
            const parts = (sd >>> 0) === 0 ? null : codec.partsOf(sd);
            if (parts !== null)
            {
                recordDescriptor(path, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION, parts);
            }
        },
    };
}
