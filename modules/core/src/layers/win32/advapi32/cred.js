/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The credential manager: what a program saves a user name and a password
 * under, by target and type, and reads back. The store is the session's --
 * CredGetSessionTypes says so for every type it keeps -- so nothing a program
 * saves outlives the run, and nothing is written to the volume in the clear.
 *
 * A credential handed out is one block the caller gives to CredFree: the
 * CREDENTIAL and every string and byte it points to. A domain password is
 * kept and matched but never read back: the system uses it to log on, and a
 * program reading it gets none.
 *
 * CredMarshalCredential's text is "@@", the kind, and the structure's bytes
 * six bits to a character, lowest bits first, from an alphabet of its own.
 */

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_FLAGS = 1004;
const ERROR_NOT_FOUND = 1168;
const ERROR_BAD_USERNAME = 2202;

/** CRED_TYPE_*: GENERIC .. DOMAIN_EXTENDED, and the bound past them. */
const CRED_TYPE_GENERIC = 1;
const CRED_TYPE_DOMAIN_PASSWORD = 2;
const CRED_TYPE_MAXIMUM = 7;
/** CRED_PERSIST_*: none, the session, the machine, the roaming profile. */
const CRED_PERSIST_SESSION = 1;
const CRED_PERSIST_ENTERPRISE = 3;

/** CREDENTIALA/W on a 32-bit machine. */
const CREDENTIAL = Object.freeze({ FLAGS: 0, TYPE: 4, TARGET: 8, COMMENT: 12, WRITTEN: 16,
    BLOB_SIZE: 24, BLOB: 28, PERSIST: 32, ATTRIBUTE_COUNT: 36, ATTRIBUTES: 40, ALIAS: 44,
    USER: 48, SIZE: 52 });

/** CRED_MARSHAL_TYPE: a certificate's hash, and a user name for a target. */
const CertCredential = 1;
const UsernameTargetCredential = 2;
/** CERT_CREDENTIAL_INFO: its size and a SHA-1 hash. */
const CERT_INFO_SIZE = 24;
const CERT_HASH_LENGTH = 20;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#-';

/** @param {Uint8Array} bytes @returns {string} six bits to a character, lowest first */
const encode = bytes=>{
    let text = '';
    let bits = 0;
    let held = 0;
    for (const byte of bytes)
    {
        held |= byte << bits;
        bits += 8;
        while (bits >= 6)
        {
            text += ALPHABET[held & 63];
            held >>>= 6;
            bits -= 6;
        }
    }
    return bits > 0 ? text + ALPHABET[held & 63] : text;
};

/**
 * @param {string} text @param {number} length  The bytes it holds.
 * @returns {Uint8Array | null} null when a character is not one of the alphabet's
 */
const decode = (text, length)=>{
    const bytes = new Uint8Array(length);
    let bits = 0;
    let held = 0;
    let at = 0;
    for (const char of text)
    {
        const value = ALPHABET.indexOf(char);
        if (value < 0)
        {
            return null;
        }
        held |= value << bits;
        bits += 6;
        if (bits >= 8 && at < length)
        {
            bytes[at++] = held & 0xff;
            held >>>= 8;
            bits -= 8;
        }
    }
    return bytes;
};

/** @param {number} bytes @returns {number} the characters that many bytes take */
const charsFor = bytes=>Math.ceil(bytes * 8 / 6);

/**
 * What a marshalled credential's text says: its kind, read whenever the text
 * has one, and its structure's bytes when the rest is well formed.
 *
 * @param {string} text
 * @returns {{ kind: number, cert?: Uint8Array, user?: string }}
 */
export const unmarshal = text=>{
    if (!text.startsWith('@@') || text.length < 3)
    {
        return { kind: 0 };
    }
    const kind = ALPHABET.indexOf(text[2]);
    if (kind < 0)
    {
        return { kind: 0 };
    }
    const body = text.slice(3);
    if (kind === CertCredential)
    {
        const cert = body.length === charsFor(CERT_HASH_LENGTH)
            ? decode(body, CERT_HASH_LENGTH) : null;
        return cert ? { kind, cert } : { kind };
    }
    if (kind === UsernameTargetCredential && body.length >= 6)
    {
        const head = decode(body.slice(0, 6), 4);
        const size = head ? new DataView(head.buffer).getUint32(0, true) : 0;
        const rest = body.slice(6);
        if (size === 0 || size % 2 !== 0 || size > 0xffff || rest.length !== charsFor(size))
        {
            return { kind };
        }
        const name = decode(rest, size);
        if (!name)
        {
            return { kind };
        }
        const units = new Uint16Array(name.buffer, 0, size / 2);
        return { kind, user: String.fromCharCode(...units) };
    }
    return { kind };
};

/**
 * @typedef {Object} Credential
 * @property {number} flags
 * @property {number} type
 * @property {string} target
 * @property {string | null} comment
 * @property {Uint8Array} blob
 * @property {number} persist
 * @property {string | null} alias
 * @property {string | null} user
 * @property {[number, number]} written  FILETIME, low and high.
 */

/**
 * @typedef {Object} CredHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} allocate  What CredFree gives back.
 * @property {(address: number) => void} [release]
 * @property {() => [number, number]} [now]  The wall clock as a FILETIME.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {CredHost} host
 */
export function createCredFunctions(host){
    /** @type {Credential[]} */
    const store = [];

    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };
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
    /** @param {number} address @returns {string | null} */
    const textAt = address=>((address >>> 0) === 0 ? null
        : host.readCString(address >>> 0, 0x8000));
    /** @param {number} address @returns {string | null} */
    const wideAt = address=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        let text = '';
        for (let at = address >>> 0; text.length < 0x8000; at += 2)
        {
            const unit = host.readMemory(at, 2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };
    /** @param {string} text */
    const ansi = text=>new Uint8Array([...text].map(char=>char.charCodeAt(0) & 0xff).concat(0));

    /** @param {number} type */
    const validType = type=>type >= CRED_TYPE_GENERIC && type < CRED_TYPE_MAXIMUM;

    /** @param {string} target @param {number} type */
    const find = (target, type)=>store.findIndex(entry=>entry.type === type
        && entry.target.toUpperCase() === target.toUpperCase());

    /**
     * A CREDENTIALA, in the block given, with its strings and blob after the
     * structure -- at `at`; the pointers are absolute. A domain password's
     * blob stays with the system.
     *
     * @param {Credential} entry @param {number} base @param {number} at
     * @returns {{ bytes: Uint8Array, size: number }}
     */
    const layout = (entry, base, at)=>{
        /** @type {[number, Uint8Array][]} */
        const parts = [];
        const head = new Uint8Array(CREDENTIAL.SIZE);
        const view = new DataView(head.buffer);
        let next = at + CREDENTIAL.SIZE;
        /** @param {number} slot @param {Uint8Array | null} bytes */
        const place = (slot, bytes)=>{
            if (bytes === null)
            {
                return;
            }
            view.setUint32(slot, base + next, true);
            parts.push([next, bytes]);
            next += bytes.length + 3 & ~3;
        };
        view.setUint32(CREDENTIAL.FLAGS, entry.flags, true);
        view.setUint32(CREDENTIAL.TYPE, entry.type, true);
        place(CREDENTIAL.TARGET, ansi(entry.target));
        place(CREDENTIAL.COMMENT, entry.comment === null ? null : ansi(entry.comment));
        view.setUint32(CREDENTIAL.WRITTEN, entry.written[0], true);
        view.setUint32(CREDENTIAL.WRITTEN + 4, entry.written[1], true);
        const hidden = entry.type === CRED_TYPE_DOMAIN_PASSWORD || entry.blob.length === 0;
        view.setUint32(CREDENTIAL.BLOB_SIZE, hidden ? 0 : entry.blob.length, true);
        place(CREDENTIAL.BLOB, hidden ? null : entry.blob);
        view.setUint32(CREDENTIAL.PERSIST, entry.persist, true);
        place(CREDENTIAL.ALIAS, entry.alias === null ? null : ansi(entry.alias));
        place(CREDENTIAL.USER, entry.user === null ? null : ansi(entry.user));
        const bytes = new Uint8Array(next - at);
        bytes.set(head, 0);
        for (const [offset, part] of parts)
        {
            bytes.set(part, offset - at);
        }
        return { bytes, size: next - at };
    };

    /** @param {Credential} entry @returns {number} the credential, in a block of its own */
    const handOut = entry=>{
        const size = layout(entry, 0, 0).size;
        const base = host.allocate(size);
        host.writeMemory(base, layout(entry, base, 0).bytes);
        return base;
    };

    /**
     * An array of credential pointers, the credentials behind it, in one block.
     *
     * @param {Credential[]} entries
     */
    const handOutAll = entries=>{
        const sizes = entries.map(entry=>layout(entry, 0, 0).size);
        const total = entries.length * 4 + sizes.reduce((sum, size)=>sum + size, 0);
        const base = host.allocate(total);
        const bytes = new Uint8Array(total);
        const view = new DataView(bytes.buffer);
        let at = entries.length * 4;
        entries.forEach((entry, index)=>{
            view.setUint32(index * 4, base + at, true);
            bytes.set(layout(entry, base, at).bytes, at);
            at += sizes[index];
        });
        host.writeMemory(base, bytes);
        return base;
    };

    /** @param {string} filter @param {string} target  A prefix and a star, or the target. */
    const matches = (filter, target)=>(filter.endsWith('*')
        ? target.toUpperCase().startsWith(filter.slice(0, -1).toUpperCase())
        : target.toUpperCase() === filter.toUpperCase());

    return {
        /**
         * BOOL CredWriteA(PCREDENTIALA Credential, DWORD Flags)
         *
         * Kept under its target and type, over one already there. A domain
         * credential names the account it logs on as.
         */
        CredWriteA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([credential])=>{
                if ((credential >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                /** @param {number} slot */
                const field = slot=>readDword(credential + slot);
                const type = field(CREDENTIAL.TYPE);
                const target = textAt(field(CREDENTIAL.TARGET));
                const persist = field(CREDENTIAL.PERSIST);
                if (!validType(type) || target === null || persist < CRED_PERSIST_SESSION
                    || persist > CRED_PERSIST_ENTERPRISE)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const user = textAt(field(CREDENTIAL.USER));
                if (type !== CRED_TYPE_GENERIC && !user)
                {
                    return fail(ERROR_BAD_USERNAME);
                }
                const blobSize = field(CREDENTIAL.BLOB_SIZE);
                /** @type {Credential} */
                const entry = {
                    flags: field(CREDENTIAL.FLAGS), type, target,
                    comment: textAt(field(CREDENTIAL.COMMENT)),
                    blob: blobSize === 0 || field(CREDENTIAL.BLOB) === 0 ? new Uint8Array(0)
                        : host.readMemory(field(CREDENTIAL.BLOB), blobSize).slice(),
                    persist, alias: textAt(field(CREDENTIAL.ALIAS)), user,
                    written: host.now?.() ?? [0, 0],
                };
                const at = find(target, type);
                if (at >= 0)
                {
                    store[at] = entry;
                }
                else
                {
                    store.push(entry);
                }
                host.setLastError(0);
                return 1;
            },
        },

        /** BOOL CredReadA(LPCSTR TargetName, DWORD Type, DWORD Flags, PCREDENTIALA *Credential) */
        CredReadA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([targetName, type, flags, out])=>{
                if (!validType(type >>> 0) || (targetName >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_FLAGS);
                }
                const at = find(/** @type {string} */ (textAt(targetName)), type >>> 0);
                if (at < 0)
                {
                    return fail(ERROR_NOT_FOUND);
                }
                writeDword(out, handOut(store[at]));
                return 1;
            },
        },

        /** BOOL CredDeleteA(LPCSTR TargetName, DWORD Type, DWORD Flags) */
        CredDeleteA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([targetName, type, flags])=>{
                if (!validType(type >>> 0) || (targetName >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_FLAGS);
                }
                const at = find(/** @type {string} */ (textAt(targetName)), type >>> 0);
                if (at < 0)
                {
                    return fail(ERROR_NOT_FOUND);
                }
                store.splice(at, 1);
                return 1;
            },
        },

        /**
         * BOOL CredEnumerateA(LPCSTR Filter, DWORD Flags, DWORD *Count,
         *   PCREDENTIALA **Credentials)
         *
         * Every credential, or those whose target the filter names -- a
         * prefix and a star; none is ERROR_NOT_FOUND.
         */
        CredEnumerateA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([filterName, flags, count, out])=>{
                if ((count >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_FLAGS);
                }
                const filter = textAt(filterName);
                const found = store.filter(entry=>filter === null || matches(filter, entry.target));
                if (found.length === 0)
                {
                    return fail(ERROR_NOT_FOUND);
                }
                writeDword(count, found.length);
                writeDword(out, handOutAll(found));
                return 1;
            },
        },

        /**
         * BOOL CredReadDomainCredentialsA(PCREDENTIAL_TARGET_INFORMATIONA TargetInfo,
         *   DWORD Flags, DWORD *Count, PCREDENTIALA **Credentials)
         *
         * The domain credentials for the target, its NetBIOS or its DNS
         * server name; the count and list are cleared before the search.
         */
        CredReadDomainCredentialsA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([info, flags, count, out])=>{
                if ((info >>> 0) === 0 || (count >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_FLAGS);
                }
                writeDword(count, 0);
                writeDword(out, 0);
                // TargetName, NetbiosServerName, DnsServerName: the first three names.
                const names = [0, 4, 8].map(slot=>textAt(readDword(info + slot)))
                    .filter(name=>name !== null).map(name=>/** @type {string} */ (name)
                        .toUpperCase());
                const found = store.filter(entry=>entry.type !== CRED_TYPE_GENERIC
                    && names.includes(entry.target.toUpperCase()));
                if (found.length === 0)
                {
                    return fail(ERROR_NOT_FOUND);
                }
                writeDword(count, found.length);
                writeDword(out, handOutAll(found));
                return 1;
            },
        },

        /** VOID CredFree(PVOID Buffer) */
        CredFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                if ((buffer >>> 0) !== 0)
                {
                    host.release?.(buffer >>> 0);
                }
                return 0;
            },
        },

        /**
         * BOOL CredGetSessionTypes(DWORD MaximumPersistCount, LPDWORD MaximumPersist)
         *
         * The session, for every type kept: what a program saves lasts as
         * long as the run does. The first entry, which names no type, is none.
         */
        CredGetSessionTypes: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([count, out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                for (let type = 0; type < (count >>> 0); type++)
                {
                    writeDword((out >>> 0) + type * 4, validType(type) ? CRED_PERSIST_SESSION : 0);
                }
                return 1;
            },
        },

        /**
         * BOOL CredMarshalCredentialA(CRED_MARSHAL_TYPE, PVOID Credential,
         *   LPSTR *MarshaledCredential)
         *
         * A certificate is its hash; a user name is its length in bytes and
         * its UTF-16. The text is a block for CredFree.
         */
        CredMarshalCredentialA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([kind, credential, out])=>{
                if ((credential >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                let body;
                if ((kind >>> 0) === CertCredential)
                {
                    if (readDword(credential) < CERT_INFO_SIZE)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    body = encode(host.readMemory((credential >>> 0) + 4, CERT_HASH_LENGTH));
                }
                else if ((kind >>> 0) === UsernameTargetCredential)
                {
                    const user = wideAt(readDword(credential));
                    if (!user)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const name = new Uint8Array(new Uint16Array([...user]
                        .map(char=>char.charCodeAt(0))).buffer);
                    const size = new Uint8Array(4);
                    new DataView(size.buffer).setUint32(0, name.length, true);
                    body = encode(size) + encode(name);
                }
                else
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const text = ansi(`@@${ALPHABET[kind >>> 0]}${body}`);
                const block = host.allocate(text.length);
                host.writeMemory(block, text);
                writeDword(out, block);
                return 1;
            },
        },

        /**
         * BOOL CredUnmarshalCredentialA(LPCSTR MarshaledCredential,
         *   PCRED_MARSHAL_TYPE CredType, PVOID *Credential)
         *
         * The kind is answered whenever the text names one, even when the
         * rest is not well formed and the call fails.
         */
        CredUnmarshalCredentialA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([marshaled, kindOut, out])=>{
                if ((marshaled >>> 0) === 0 || (kindOut >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const read = unmarshal(/** @type {string} */ (textAt(marshaled)));
                writeDword(kindOut, read.kind);
                writeDword(out, 0);
                if (read.cert)
                {
                    const block = host.allocate(CERT_INFO_SIZE);
                    const bytes = new Uint8Array(CERT_INFO_SIZE);
                    bytes[0] = CERT_INFO_SIZE;
                    bytes.set(read.cert, 4);
                    host.writeMemory(block, bytes);
                    writeDword(out, block);
                    return 1;
                }
                if (read.user !== undefined)
                {
                    const name = new Uint8Array(new Uint16Array([...read.user, '\0']
                        .map(char=>char.charCodeAt(0))).buffer);
                    const block = host.allocate(4 + name.length);
                    const bytes = new Uint8Array(4 + name.length);
                    new DataView(bytes.buffer).setUint32(0, block + 4, true);
                    bytes.set(name, 4);
                    host.writeMemory(block, bytes);
                    writeDword(out, block);
                    return 1;
                }
                return fail(ERROR_INVALID_PARAMETER);
            },
        },

        /** BOOL CredIsMarshaledCredentialA(LPCSTR MarshaledCredential) */
        CredIsMarshaledCredentialA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([marshaled])=>{
                const read = unmarshal(textAt(marshaled) ?? '');
                return read.cert || read.user !== undefined ? 1 : fail(ERROR_INVALID_PARAMETER);
            },
        },
    };
}
