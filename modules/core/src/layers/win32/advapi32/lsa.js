/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Local Security Authority's client calls: a policy handle onto this
 * machine, what the policy says about its domains, and the translations
 * between account names and SIDs. Every answer is an NTSTATUS, and every
 * structure handed out is one block the caller gives back to LsaFreeMemory --
 * the structures, their strings and their SIDs together.
 *
 * The machine is a workgroup member: its primary domain is the workgroup,
 * which has no SID, and its account domain is the machine itself.
 */

import { COMPUTER_NAME } from '../kernel32/drives.js';
import {
    PRIVILEGES, USER_NAME, accountNamed, accountOfSid, isThisMachine, sidBytes, sidText,
} from './tokens.js';

const STATUS_SUCCESS = 0;
const STATUS_SOME_NOT_MAPPED = 0x00000107;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_NO_SUCH_PRIVILEGE = 0xc0000060;
const STATUS_NONE_MAPPED = 0xc0000073;
const RPC_NT_SERVER_UNAVAILABLE = 0xc0020017;

/** POLICY_INFORMATION_CLASS. */
const PolicyAuditEventsInformation = 2;
const PolicyPrimaryDomainInformation = 3;
const PolicyAccountDomainInformation = 5;
const PolicyDnsDomainInformation = 12;

/** SID_NAME_USE of a name that maps to nothing. */
const SidTypeUnknown = 8;

/** The workgroup a machine not in a domain is in, as setup names it. */
const WORKGROUP = 'WORKGROUP';

/**
 * @typedef {Object} LsaHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  What LsaFreeMemory gives back.
 * @property {(address: number) => void} [release]
 */

/**
 * One block laid out in two passes: the fixed structures first, then each
 * string and SID they point to, the pointers made absolute once the block
 * has an address.
 */
class Block {
    /** @param {number} fixed  The size of the structures at its start. */
    constructor(fixed){
        this.size = fixed;
        /** @type {[number, Uint8Array][]} */
        this.blobs = [];
        /** @type {[number, number, number][]} */
        this.words = [];
    }

    /** @param {Uint8Array} bytes @returns {number} where it lands, from the start */
    blob(bytes){
        const at = this.size;
        this.blobs.push([at, bytes]);
        this.size = at + bytes.length + 3 & ~3;
        return at;
    }

    /** @param {number} at @param {number} value */
    u32(at, value){
        this.words.push([at, 4, value >>> 0]);
    }

    /** @param {number} at @param {number} value */
    u16(at, value){
        this.words.push([at, 2, value & 0xffff]);
    }

    /** @param {number} at @param {number} target  An offset in the block, made a pointer. */
    pointer(at, target){
        this.words.push([at, -4, target]);
    }

    /**
     * An LSA_UNICODE_STRING at an offset: its length in bytes, room for the
     * terminator after it, and the text itself in the block.
     *
     * @param {number} at @param {string} text
     */
    string(at, text){
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index * 2] = text.charCodeAt(index) & 0xff;
            bytes[index * 2 + 1] = text.charCodeAt(index) >>> 8;
        }
        this.u16(at, text.length * 2);
        this.u16(at + 2, bytes.length);
        this.pointer(at + 4, this.blob(bytes));
    }

    /** @param {LsaHost} host @returns {number} the block's address */
    write(host){
        const base = host.allocate(Math.max(this.size, 4));
        const bytes = new Uint8Array(Math.max(this.size, 4));
        const view = new DataView(bytes.buffer);
        for (const [at, blob] of this.blobs)
        {
            bytes.set(blob, at);
        }
        for (const [at, width, value] of this.words)
        {
            if (width === 2)
            {
                view.setUint16(at, value, true);
            }
            else
            {
                view.setUint32(at, width < 0 ? base + value : value, true);
            }
        }
        host.writeMemory(base, bytes);
        return base;
    }
}

/** @param {Uint8Array} sid @returns {Uint8Array | null} the SID of the domain it is in */
const domainSidOf = sid=>{
    if (sid[1] === 0)
    {
        return null;
    }
    const domain = sid.slice(0, sid.length - 4);
    domain[1] -= 1;
    return domain;
};

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {LsaHost} host
 */
export function createLsaFunctions(host){
    /** The policy handles open, by the address that names each. */
    const policies = new Set();

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} at  An LSA_UNICODE_STRING's address. @returns {string | null} */
    const unicodeAt = at=>{
        if ((at >>> 0) === 0)
        {
            return null;
        }
        const head = host.readMemory(at >>> 0, 8);
        const length = head[0] | head[1] << 8;
        const buffer = (head[4] | head[5] << 8 | head[6] << 16 | head[7] << 24) >>> 0;
        const bytes = buffer === 0 ? new Uint8Array(0) : host.readMemory(buffer, length & ~1);
        let text = '';
        for (let index = 0; index + 1 < bytes.length; index += 2)
        {
            text += String.fromCharCode(bytes[index] | bytes[index + 1] << 8);
        }
        return text;
    };
    /** @param {number} at */
    const sidAt = at=>{
        if ((at >>> 0) === 0)
        {
            return null;
        }
        const head = host.readMemory(at >>> 0, 2);
        return head[0] === 1 && head[1] <= 15
            ? host.readMemory(at >>> 0, 8 + 4 * head[1]).slice() : null;
    };

    /**
     * The domains a lookup referenced, in the order first met, and each
     * name's index into them.
     */
    const domainList = ()=>{
        /** @type {{ name: string, sid: Uint8Array | null }[]} */
        const domains = [];
        return {
            domains,
            /** @param {string} name @param {Uint8Array | null} sid */
            index: (name, sid)=>{
                const found = domains.findIndex(entry=>entry.name.toUpperCase()
                    === name.toUpperCase());
                if (found >= 0)
                {
                    return found;
                }
                domains.push({ name, sid });
                return domains.length - 1;
            },
            /** @returns {number} LSA_REFERENCED_DOMAIN_LIST, written */
            write: ()=>{
                const block = new Block(8);
                block.u32(0, domains.length);
                if (domains.length > 0)
                {
                    const trust = block.blob(new Uint8Array(12 * domains.length));
                    block.pointer(4, trust);
                    domains.forEach((entry, at)=>{
                        block.string(trust + at * 12, entry.name);
                        if (entry.sid)
                        {
                            block.pointer(trust + at * 12 + 8, block.blob(entry.sid));
                        }
                    });
                }
                return block.write(host);
            },
        };
    };

    /** @param {number} policy */
    const isPolicy = policy=>policies.has(policy >>> 0);

    /** @param {number} count  How many of a lookup's names were mapped, of how many. @param {number} of */
    const lookupStatus = (count, of)=>(count === 0 ? STATUS_NONE_MAPPED
        : count < of ? STATUS_SOME_NOT_MAPPED : STATUS_SUCCESS);

    /**
     * NTSTATUS LsaLookupNames2(LSA_HANDLE, ULONG Flags, ULONG Count,
     *   PLSA_UNICODE_STRING Names, PLSA_REFERENCED_DOMAIN_LIST *ReferencedDomains,
     *   PLSA_TRANSLATED_SID2 *Sids)
     * NTSTATUS LsaLookupNames(LSA_HANDLE, ULONG Count, PLSA_UNICODE_STRING Names,
     *   PLSA_REFERENCED_DOMAIN_LIST *ReferencedDomains, PLSA_TRANSLATED_SID *Sids)
     *
     * Each name's SID and use, and the domains they are in; a name that maps
     * to nothing is SidTypeUnknown with no domain. The old form gives each
     * account its RID rather than its SID.
     *
     * @param {boolean} second  LsaLookupNames2's form.
     */
    const lookupNames = second=>(/** @type {number[]} */ args)=>{
        const [policy, count, names, domainsOut, sidsOut] = second
            ? [args[0], args[2], args[3], args[4], args[5]] : args;
        if (!isPolicy(policy))
        {
            return STATUS_INVALID_HANDLE;
        }
        if ((domainsOut >>> 0) === 0 || (sidsOut >>> 0) === 0 || (names >>> 0) === 0)
        {
            return STATUS_INVALID_PARAMETER;
        }
        const list = domainList();
        const stride = second ? 16 : 12;
        const block = new Block(stride * (count >>> 0));
        let mapped = 0;
        for (let at = 0; at < (count >>> 0); at++)
        {
            const written = unicodeAt((names >>> 0) + at * 8) ?? '';
            const found = written === '' ? null : accountNamed(written);
            const entry = at * stride;
            if (found === null)
            {
                block.u32(entry, SidTypeUnknown);
                block.u32(entry + (second ? 8 : 8), 0xffffffff);
                continue;
            }
            mapped++;
            const sid = sidBytes(found.sid);
            const domainSid = domainSidOf(sid);
            block.u32(entry, found.use);
            if (second)
            {
                block.pointer(entry + 4, block.blob(sid));
            }
            else
            {
                block.u32(entry + 4, found.sid.subAuthorities.at(-1) ?? 0);
            }
            block.u32(entry + 8, list.index(found.domain, domainSid));
        }
        writeDword(sidsOut, block.write(host));
        writeDword(domainsOut, list.write());
        return lookupStatus(mapped, count >>> 0);
    };

    return {
        /**
         * NTSTATUS LsaOpenPolicy(PLSA_UNICODE_STRING SystemName,
         *   PLSA_OBJECT_ATTRIBUTES, ACCESS_MASK, PLSA_HANDLE PolicyHandle)
         *
         * A handle onto this machine's policy; any other machine is one there
         * is no network to reach.
         */
        LsaOpenPolicy: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([system, attributes, , out])=>{
                if (!isThisMachine(unicodeAt(system)))
                {
                    return RPC_NT_SERVER_UNAVAILABLE;
                }
                if ((attributes >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                const handle = host.allocate(4);
                policies.add(handle >>> 0);
                writeDword(out, handle);
                return STATUS_SUCCESS;
            },
        },

        /** NTSTATUS LsaClose(LSA_HANDLE ObjectHandle) */
        LsaClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!policies.delete(handle >>> 0))
                {
                    return STATUS_INVALID_HANDLE;
                }
                host.release?.(handle >>> 0);
                return STATUS_SUCCESS;
            },
        },

        /** NTSTATUS LsaFreeMemory(PVOID Buffer): a block an LSA call handed out. */
        LsaFreeMemory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                if ((buffer >>> 0) !== 0)
                {
                    host.release?.(buffer >>> 0);
                }
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS LsaQueryInformationPolicy(LSA_HANDLE, POLICY_INFORMATION_CLASS,
         *   PVOID *Buffer)
         *
         * Auditing off; the workgroup as the primary domain, with no SID; the
         * machine as the account domain; and DNS names a workgroup machine
         * does not have.
         */
        LsaQueryInformationPolicy: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([policy, kind, out])=>{
                if (!isPolicy(policy))
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((out >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                /** @type {Block} */
                let block;
                switch (kind >>> 0)
                {
                    case PolicyAuditEventsInformation:
                        // POLICY_AUDIT_EVENTS_INFO: off, no options, no events.
                        block = new Block(12);
                        break;
                    case PolicyPrimaryDomainInformation:
                        block = new Block(12);
                        block.string(0, WORKGROUP);
                        break;
                    case PolicyAccountDomainInformation:
                    {
                        block = new Block(12);
                        block.string(0, COMPUTER_NAME);
                        const machine = accountNamed(COMPUTER_NAME);
                        if (machine)
                        {
                            block.pointer(8, block.blob(sidBytes(machine.sid)));
                        }
                        break;
                    }
                    case PolicyDnsDomainInformation:
                        // Three names, the domain's GUID and its SID: a
                        // workgroup's name and nothing else.
                        block = new Block(44);
                        block.string(0, WORKGROUP);
                        break;
                    default:
                        return STATUS_INVALID_PARAMETER;
                }
                writeDword(out, block.write(host));
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS LsaEnumerateAccountRights(LSA_HANDLE, PSID AccountSid,
         *   PLSA_UNICODE_STRING *UserRights, PULONG CountOfRights)
         *
         * No account here was granted a right by name: the account has its
         * rights through its groups, so its own entry is not found.
         */
        LsaEnumerateAccountRights: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([policy, sid, rights, count])=>{
                if (!isPolicy(policy))
                {
                    return STATUS_INVALID_HANDLE;
                }
                if (sidAt(sid) === null || (rights >>> 0) === 0 || (count >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                writeDword(rights, 0);
                writeDword(count, 0);
                return STATUS_OBJECT_NAME_NOT_FOUND;
            },
        },

        LsaLookupNames: { argBytes: 20, handler: lookupNames(false) },
        LsaLookupNames2: { argBytes: 24, handler: lookupNames(true) },

        /**
         * NTSTATUS LsaLookupSids(LSA_HANDLE, ULONG Count, PSID *Sids,
         *   PLSA_REFERENCED_DOMAIN_LIST *ReferencedDomains, PLSA_TRANSLATED_NAME *Names)
         *
         * Each SID's account name and use; a SID nobody is named by is written
         * as its text, SidTypeUnknown, in no domain.
         */
        LsaLookupSids: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([policy, count, sids, domainsOut, namesOut])=>{
                if (!isPolicy(policy))
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((sids >>> 0) === 0 || (domainsOut >>> 0) === 0 || (namesOut >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                const list = domainList();
                const block = new Block(16 * (count >>> 0));
                let mapped = 0;
                for (let at = 0; at < (count >>> 0); at++)
                {
                    const sid = sidAt(readDword((sids >>> 0) + at * 4));
                    const found = sid === null ? null : accountOfSid(sid);
                    const entry = at * 16;
                    if (found === null)
                    {
                        block.u32(entry, SidTypeUnknown);
                        block.string(entry + 4, sid === null ? '' : sidText(sid));
                        block.u32(entry + 12, 0xffffffff);
                        continue;
                    }
                    mapped++;
                    block.u32(entry, found.use);
                    block.string(entry + 4, found.name);
                    block.u32(entry + 12, list.index(found.domain,
                        domainSidOf(sidBytes(found.sid))));
                }
                writeDword(namesOut, block.write(host));
                writeDword(domainsOut, list.write());
                return lookupStatus(mapped, count >>> 0);
            },
        },

        /**
         * NTSTATUS LsaLookupPrivilegeName(LSA_HANDLE, PLUID Value,
         *   PLSA_UNICODE_STRING *Name)
         */
        LsaLookupPrivilegeName: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([policy, luid, out])=>{
                if (!isPolicy(policy))
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((luid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                const low = readDword(luid);
                const name = readDword((luid >>> 0) + 4) === 0
                    ? [...PRIVILEGES].find(([, value])=>value === low)?.[0] : undefined;
                if (name === undefined)
                {
                    writeDword(out, 0);
                    return STATUS_NO_SUCH_PRIVILEGE;
                }
                const block = new Block(8);
                block.string(0, name);
                writeDword(out, block.write(host));
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS LsaGetUserName(PUNICODE_STRING *UserName, PUNICODE_STRING *DomainName)
         *
         * The account and the machine whose account it is, each a block of
         * its own.
         */
        LsaGetUserName: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([user, domain])=>{
                if ((user >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                for (const [out, text] of /** @type {const} */ ([[user, USER_NAME],
                    [domain, COMPUTER_NAME]]))
                {
                    if ((out >>> 0) !== 0)
                    {
                        const block = new Block(8);
                        block.string(0, text);
                        writeDword(out, block.write(host));
                    }
                }
                return STATUS_SUCCESS;
            },
        },
    };
}
