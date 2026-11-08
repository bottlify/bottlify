/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An assembly's name as fusion holds it - the simple name, the version's
 * parts, the culture, the public key token, the processor architecture - and
 * the IAssemblyName object over it. The display form is the text a program
 * writes, `name, Version=1.2.3.4, Culture=neutral, PublicKeyToken=...`, read
 * and written here; what a field holds that the text never set stays unset,
 * so a property asked for and a comparison made see only what was named.
 *
 * The contract is Wine's fusion tests (asmname.c, asmenum.c), which say what
 * Windows answers.
 */

import { createComObject } from '../ole32/objects.js';
import { createSha1 } from '../crypto/digest.js';

export const S_OK = 0;
export const S_FALSE = 1;
export const E_NOTIMPL = 0x80004001 | 0;
export const E_INVALIDARG = 0x80070057 | 0;
/** Also STRSAFE_E_INSUFFICIENT_BUFFER, which GetProperty answers. */
export const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
export const FUSION_E_INVALID_NAME = 0x80131047 | 0;

export const IID_IASSEMBLY_NAME = '{CD193BC0-B4BC-11D2-9833-00C04FC31D2E}';

/** CreateAssemblyNameObject's flags. */
export const CANOF_PARSE_DISPLAY_NAME = 0x1;

/** The properties (ASM_NAME) this object answers with a value of its own. */
export const ASM_NAME = Object.freeze({
    PUBLIC_KEY: 0, PUBLIC_KEY_TOKEN: 1, NAME: 3, MAJOR_VERSION: 4, REVISION_NUMBER: 7,
    CULTURE: 8, NULL_PUBLIC_KEY: 15, NULL_PUBLIC_KEY_TOKEN: 16, NULL_CUSTOM: 18,
    ARCHITECTURE: 27, MAX_PARAMS: 28,
});

/** GetDisplayName's flags; none at all is the full name. */
const DISPLAY = Object.freeze({ VERSION: 0x1, CULTURE: 0x2, TOKEN: 0x4, PUBLIC_KEY: 0x8,
    ARCHITECTURE: 0x20, FULL: 0xa7 });

/** IsEqual's flags: the name, each part of the version, the token, the culture. */
const COMPARE = Object.freeze({ NAME: 0x1, MAJOR: 0x2, TOKEN: 0x20, CULTURE: 0x40,
    IL_ALL: 0x7f });

/** PEKIND, as `processorArchitecture` spells each. */
export const ARCHITECTURES = Object.freeze(new Map([
    [1, 'MSIL'], [2, 'x86'], [3, 'IA64'], [4, 'AMD64'], [5, 'ARM'],
]));

/**
 * What an assembly name holds. A field that was never set is null (the
 * version: the parts set, left to right); a neutral culture is set and empty.
 *
 * @typedef {Object} AssemblyFields
 * @property {string | null} name
 * @property {number[]} version
 * @property {string | null} culture
 * @property {Uint8Array | null} token     eight bytes
 * @property {boolean} nullToken           `PublicKeyToken=null`: named as having none
 * @property {Uint8Array | null} publicKey
 * @property {number | null} architecture  PEKIND
 * @property {Map<number, Uint8Array>} others  properties set that nothing here reads
 */

/** @returns {AssemblyFields} */
export const emptyFields = ()=>({ name: null, version: [], culture: null, token: null,
    nullToken: false, publicKey: null, architecture: null, others: new Map() });

/** @param {AssemblyFields} fields @returns {AssemblyFields} */
const copyFields = fields=>({ ...fields, version: [...fields.version],
    others: new Map(fields.others) });

/** @param {Uint8Array} bytes */
export const hexOf = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');

/**
 * A strong name's token: the last eight bytes of the key's SHA-1, in
 * reverse (ECMA-335, II.6.2.1.3).
 *
 * @param {Uint8Array} publicKey
 */
export function tokenOf(publicKey){
    const sha = createSha1();
    sha.update(publicKey);
    return sha.digest().slice(-8).reverse();
}

/**
 * A version as the display form writes it: decimal parts, at most four.
 *
 * @param {string} text
 * @returns {number[] | null}
 */
export function versionParts(text){
    const parts = text.split('.');
    if (parts.length > 4 || parts.some(part=>!/^\d{1,9}$/.test(part) || Number(part) > 0xffff))
    {
        return null;
    }
    return parts.map(Number);
}

/**
 * The display form read into fields, or FUSION_E_INVALID_NAME: a segment
 * without `=` or with nothing after it, a token that is not sixteen hex
 * digits, a version or architecture that is not one. A property this does
 * not know is passed over, as Windows passes it.
 *
 * @param {string} text
 * @returns {AssemblyFields | number}
 */
export function parseDisplayName(text){
    const segments = text.split(',');
    const fields = emptyFields();
    const name = segments[0].trim();
    if (name === '' || name.includes('='))
    {
        return FUSION_E_INVALID_NAME;
    }
    fields.name = name;
    for (const segment of segments.slice(1))
    {
        const equals = segment.indexOf('=');
        if (equals < 0)
        {
            return FUSION_E_INVALID_NAME;
        }
        const key = segment.slice(0, equals).trim().toLowerCase();
        const value = segment.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1');
        if (value === '')
        {
            return FUSION_E_INVALID_NAME;
        }
        if (key === 'version')
        {
            const parts = versionParts(value);
            if (!parts)
            {
                return FUSION_E_INVALID_NAME;
            }
            fields.version = parts;
        }
        else if (key === 'culture')
        {
            fields.culture = value.toLowerCase() === 'neutral' ? '' : value;
        }
        else if (key === 'publickeytoken')
        {
            if (value.toLowerCase() === 'null')
            {
                fields.nullToken = true;
            }
            else if (/^[0-9a-f]{16}$/i.test(value))
            {
                fields.token = Uint8Array.from(value.match(/../g) ?? [], pair=>parseInt(pair, 16));
            }
            else
            {
                return FUSION_E_INVALID_NAME;
            }
        }
        else if (key === 'publickey')
        {
            if (!/^([0-9a-f]{2})+$/i.test(value))
            {
                return FUSION_E_INVALID_NAME;
            }
            fields.publicKey = Uint8Array.from(value.match(/../g) ?? [], pair=>parseInt(pair, 16));
            fields.token = tokenOf(fields.publicKey);
        }
        else if (key === 'processorarchitecture')
        {
            const kind = [...ARCHITECTURES].find(([, spelled])=>
                spelled.toLowerCase() === value.toLowerCase());
            if (!kind)
            {
                return FUSION_E_INVALID_NAME;
            }
            fields.architecture = kind[0];
        }
    }
    return fields;
}

/**
 * The display form of what is set, for GetDisplayName's flags; null when the
 * name is not set or empty, which has no display form.
 *
 * @param {AssemblyFields} fields @param {number} flags
 * @returns {string | null}
 */
export function displayName(fields, flags){
    if (!fields.name)
    {
        return null;
    }
    const wanted = flags === 0 ? DISPLAY.FULL : flags;
    const parts = [fields.name];
    if (wanted & DISPLAY.VERSION && fields.version.length > 0)
    {
        parts.push(`Version=${fields.version.join('.')}`);
    }
    if (wanted & DISPLAY.CULTURE && fields.culture !== null)
    {
        parts.push(`Culture=${fields.culture || 'neutral'}`);
    }
    if (wanted & DISPLAY.TOKEN && (fields.token || fields.nullToken))
    {
        parts.push(`PublicKeyToken=${fields.token ? hexOf(fields.token) : 'null'}`);
    }
    if (wanted & DISPLAY.PUBLIC_KEY && fields.publicKey)
    {
        parts.push(`PublicKey=${hexOf(fields.publicKey)}`);
    }
    if (wanted & DISPLAY.ARCHITECTURE && fields.architecture !== null)
    {
        parts.push(`processorArchitecture=${ARCHITECTURES.get(fields.architecture)}`);
    }
    return parts.join(', ');
}

/**
 * Whether two names agree on what IsEqual's flags ask about, each field
 * compared only where both name it: `wine` is `wine, Version=1.0.0.0`.
 * Names and cultures compare without case.
 *
 * @param {AssemblyFields} a @param {AssemblyFields} b @param {number} flags
 */
export function namesAgree(a, b, flags){
    const wanted = flags === 0 ? COMPARE.IL_ALL : flags;
    /** @param {string | null} x @param {string | null} y */
    const sameText = (x, y)=>x === null || y === null || x.toLowerCase() === y.toLowerCase();
    if (wanted & COMPARE.NAME && !sameText(a.name, b.name))
    {
        return false;
    }
    for (let part = 0; part < 4; part++)
    {
        if (wanted & COMPARE.MAJOR << part && part < a.version.length && part < b.version.length
            && a.version[part] !== b.version[part])
        {
            return false;
        }
    }
    if (wanted & COMPARE.CULTURE && !sameText(a.culture, b.culture))
    {
        return false;
    }
    if (wanted & COMPARE.TOKEN && (a.token || a.nullToken) && (b.token || b.nullToken))
    {
        return hexOf(a.token ?? new Uint8Array(0)) === hexOf(b.token ?? new Uint8Array(0));
    }
    return true;
}

/**
 * @typedef {Object} NameHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(object: any, iid: string) => number} publish  an interface pointer
 * @property {(pointer: number) => any} objectAt  the object behind one this engine made
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/** IAssemblyName's slots after IUnknown's, and the words each takes after `this`. */
const NAME_SLOTS = /** @type {[string, number][]} */ ([['SetProperty', 3], ['GetProperty', 3],
    ['Finalize', 0], ['GetDisplayName', 3], ['Reserved', 9], ['GetName', 2],
    ['GetVersion', 2], ['IsEqual', 2], ['Clone', 1]]);

/** @param {[string, number][]} slots @param {Record<string, Function>} handlers */
export const methods = (slots, handlers)=>slots.map(([name, words])=>({
    name, argBytes: 4 + words * 4,
    invoke: (/** @type {any} */ _self, /** @type {number[]} */ args)=>handlers[name](args),
}));

/**
 * IAssemblyName over a set of fields: the object, which its `state.fields`
 * lets another of this library's objects read.
 *
 * @param {NameHost} host @param {AssemblyFields} fields
 */
export function createAssemblyName(host, fields){
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** @param {string} text */
    const wideBytes = text=>new Uint8Array(Uint16Array.from(`${text}\0`, unit=>
        unit.charCodeAt(0)).buffer);
    /** @param {Uint8Array} bytes */
    const wideText = bytes=>{
        const units = new Uint16Array(bytes.slice(0, bytes.length & ~1).buffer);
        const end = units.indexOf(0);
        return String.fromCharCode(...(end < 0 ? units : units.subarray(0, end)));
    };

    /**
     * A property's bytes, or null for one not set. The two "null" properties
     * have no bytes and are answered apart.
     *
     * @param {number} id
     * @returns {Uint8Array | null}
     */
    const valueOf = id=>{
        if (id === ASM_NAME.NAME)
        {
            return fields.name === null ? null : wideBytes(fields.name);
        }
        if (id === ASM_NAME.CULTURE)
        {
            return fields.culture === null ? null : wideBytes(fields.culture);
        }
        if (id >= ASM_NAME.MAJOR_VERSION && id <= ASM_NAME.REVISION_NUMBER)
        {
            const part = fields.version[id - ASM_NAME.MAJOR_VERSION];
            return part === undefined ? null : new Uint8Array(new Uint16Array([part]).buffer);
        }
        if (id === ASM_NAME.PUBLIC_KEY_TOKEN)
        {
            return fields.token;
        }
        if (id === ASM_NAME.PUBLIC_KEY)
        {
            return fields.publicKey;
        }
        if (id === ASM_NAME.ARCHITECTURE)
        {
            return fields.architecture === null ? null
                : new Uint8Array(new Uint32Array([fields.architecture]).buffer);
        }
        return fields.others.get(id) ?? null;
    };

    /**
     * Sets a property from its bytes: false for one whose bytes are not a value.
     *
     * @param {number} id @param {Uint8Array} bytes
     */
    const setValue = (id, bytes)=>{
        const u16 = ()=>bytes[0] | bytes[1] << 8;
        if (id === ASM_NAME.NAME)
        {
            fields.name = wideText(bytes);
        }
        else if (id === ASM_NAME.CULTURE)
        {
            fields.culture = wideText(bytes);
        }
        else if (id >= ASM_NAME.MAJOR_VERSION && id <= ASM_NAME.REVISION_NUMBER)
        {
            const part = id - ASM_NAME.MAJOR_VERSION;
            if (bytes.length < 2 || part > fields.version.length)
            {
                return false;
            }
            fields.version[part] = u16();
        }
        else if (id === ASM_NAME.PUBLIC_KEY_TOKEN)
        {
            if (bytes.length !== 8)
            {
                return false;
            }
            fields.token = bytes.slice();
            fields.nullToken = false;
        }
        else if (id === ASM_NAME.PUBLIC_KEY)
        {
            fields.publicKey = bytes.slice();
            fields.token = tokenOf(fields.publicKey);
        }
        else if (id === ASM_NAME.NULL_PUBLIC_KEY_TOKEN || id === ASM_NAME.NULL_PUBLIC_KEY)
        {
            fields.token = null;
            fields.publicKey = null;
            fields.nullToken = true;
        }
        else if (id === ASM_NAME.ARCHITECTURE)
        {
            if (bytes.length !== 4)
            {
                return false;
            }
            fields.architecture = new DataView(bytes.slice().buffer).getUint32(0, true);
        }
        else
        {
            fields.others.set(id, bytes.slice());
        }
        return true;
    };

    /**
     * A wide string answered into a caller's buffer of `size` characters, the
     * size needed with its terminator told back either way.
     *
     * @param {string} text @param {number} buffer @param {number} sizeAt
     */
    const answerText = (text, buffer, sizeAt)=>{
        const size = readU32(sizeAt);
        writeU32(sizeAt, text.length + 1);
        if ((buffer >>> 0) === 0 || size < text.length + 1)
        {
            return E_NOT_SUFFICIENT_BUFFER;
        }
        host.writeMemory(buffer >>> 0, wideBytes(text));
        return S_OK;
    };

    const handlers = {
        SetProperty: (/** @type {number[]} */ [id, value, size])=>{
            if ((id >>> 0) >= ASM_NAME.MAX_PARAMS || ((value >>> 0) === 0 && (size >>> 0) !== 0))
            {
                return E_INVALIDARG;
            }
            const bytes = (size >>> 0) === 0 ? new Uint8Array(0)
                : host.readMemory(value >>> 0, size >>> 0).slice();
            return setValue(id >>> 0, bytes) ? S_OK : E_INVALIDARG;
        },
        GetProperty: (/** @type {number[]} */ [id, buffer, sizeAt])=>{
            if ((sizeAt >>> 0) === 0 || (id >>> 0) >= ASM_NAME.MAX_PARAMS)
            {
                return E_INVALIDARG;
            }
            // Whether there is no key: S_FALSE while one is known, the size
            // left as it was either way.
            if (id === ASM_NAME.NULL_PUBLIC_KEY || id === ASM_NAME.NULL_PUBLIC_KEY_TOKEN)
            {
                return fields.token || fields.nullToken ? S_OK : S_FALSE;
            }
            if (id === ASM_NAME.NULL_CUSTOM)
            {
                return S_OK;
            }
            const value = valueOf(id >>> 0);
            const size = readU32(sizeAt);
            writeU32(sizeAt, value?.length ?? 0);
            if (!value || value.length === 0)
            {
                return S_OK;
            }
            if (size < value.length || (buffer >>> 0) === 0)
            {
                return E_NOT_SUFFICIENT_BUFFER;
            }
            host.writeMemory(buffer >>> 0, value);
            return S_OK;
        },
        Finalize: ()=>S_OK,
        GetDisplayName: (/** @type {number[]} */ [buffer, sizeAt, flags])=>{
            if ((sizeAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const text = displayName(fields, flags >>> 0);
            return text === null ? FUSION_E_INVALID_NAME : answerText(text, buffer, sizeAt);
        },
        Reserved: ()=>{
            host.divergence?.('IAssemblyName::Reserved', 'the reserved method is not answered');
            return E_NOTIMPL;
        },
        GetName: (/** @type {number[]} */ [sizeAt, buffer])=>{
            if ((sizeAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (fields.name === null)
            {
                writeU32(sizeAt, 0);
                return S_OK;
            }
            return answerText(fields.name, buffer, sizeAt);
        },
        GetVersion: (/** @type {number[]} */ [highAt, lowAt])=>{
            if ((highAt >>> 0) === 0 || (lowAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const whole = fields.version.length === 4;
            const [major, minor, build, revision] = whole ? fields.version : [0, 0, 0, 0];
            writeU32(highAt, (major << 16 | minor) >>> 0);
            writeU32(lowAt, (build << 16 | revision) >>> 0);
            return whole ? S_OK : FUSION_E_INVALID_NAME;
        },
        IsEqual: (/** @type {number[]} */ [other, flags])=>{
            if ((other >>> 0) === 0)
            {
                return S_FALSE;
            }
            const theirs = host.objectAt(other >>> 0)?.state?.fields;
            if (!theirs)
            {
                host.divergence?.('IAssemblyName::IsEqual',
                    'a name this library did not make is not compared');
                return S_FALSE;
            }
            return namesAgree(fields, theirs, flags >>> 0) ? S_OK : S_FALSE;
        },
        Clone: (/** @type {number[]} */ [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, host.publish(createAssemblyName(host, copyFields(fields)),
                IID_IASSEMBLY_NAME));
            return S_OK;
        },
    };
    return createComObject(IID_IASSEMBLY_NAME, { state: { fields }, interfaces: [
        { id: IID_IASSEMBLY_NAME, methods: methods(NAME_SLOTS, handlers) },
    ] });
}
