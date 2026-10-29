/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An INF install section's registry directives, carried out on the hive: the
 * DelReg sections it names first, then the AddReg ones, as setupapi orders
 * them. What both setupapi's SetupInstallFromInfSection (SPINST_REGISTRY) and
 * advpack's RegInstall -- a library's self-registration written as an INF in
 * its resources -- do with a section.
 *
 * A line of either is `root, subkey, value name, flags, value...`: the root
 * HKCR, HKCU, HKLM, HKU, or HKR for the key the caller names; the value name
 * absent or empty for the key's default value. The flags are the documented
 * FLG_ADDREG_* and FLG_DELREG_* bits:
 *
 * - The type is the high word with FLG_ADDREG_BINVALUETYPE: none of it a
 *   string, MULTI_SZ, EXPAND_SZ; with the bit, BINARY, DWORD, NONE, or the
 *   registry type the high word names. A string type's value is the fifth
 *   field (MULTI_SZ: every field from the fifth), and a line with none sets
 *   an empty string. A binary one's value is the fields from the fifth as
 *   hexadecimal bytes; a DWORD's is one number field, or four such bytes.
 * - NOCLOBBER leaves a value that exists; OVERWRITEONLY sets only one that
 *   does; KEYONLY makes the key and sets nothing; APPEND adds a MULTI_SZ's
 *   strings that the value lacks, and a value of another type there ends
 *   the install with ERROR_INVALID_DATA, untouched; DELVAL deletes, as a
 *   DelReg line does.
 * - A DelReg line deletes the value it names, or, naming none -- or with
 *   KEYONLY_COMMON -- the key and everything under it; MULTI_SZ_DELSTRING
 *   takes one string out of a MULTI_SZ value. A key that is not there is
 *   nothing to delete.
 */

import {
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS,
    REG_BINARY, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_NONE, REG_SZ,
} from '../advapi32/registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const ERROR_SUCCESS = 0;
const ERROR_INVALID_DATA = 13;

/** @typedef {ReturnType<typeof import('../advapi32/registry.js').createHive>} Hive */
/** @typedef {import('./inf.js').Inf} Inf */
/** @typedef {import('./inf.js').InfLine} InfLine */

export const FLG_ADDREG_BINVALUETYPE = 0x00000001;
export const FLG_ADDREG_NOCLOBBER = 0x00000002;
export const FLG_ADDREG_DELVAL = 0x00000004;
export const FLG_ADDREG_APPEND = 0x00000008;
export const FLG_ADDREG_KEYONLY = 0x00000010;
export const FLG_ADDREG_OVERWRITEONLY = 0x00000020;
export const FLG_ADDREG_KEYONLY_COMMON = 0x00002000;
export const FLG_ADDREG_TYPE_MULTI_SZ = 0x00010000;
export const FLG_ADDREG_TYPE_EXPAND_SZ = 0x00020000;
export const FLG_ADDREG_TYPE_BINARY = 0x00000001;
export const FLG_ADDREG_TYPE_DWORD = 0x00010001;
export const FLG_ADDREG_TYPE_NONE = 0x00020001;
/** The bits that say a value's type. */
const FLG_ADDREG_TYPE_MASK = 0xffff0000 | FLG_ADDREG_BINVALUETYPE;
/** setupapi's own bit for a DelReg line: what tells a deletion from an addition. */
const FLG_ADDREG_DELREG_BIT = 0x00008000;
export const FLG_DELREG_MULTI_SZ_DELSTRING = FLG_ADDREG_TYPE_MULTI_SZ | FLG_ADDREG_DELREG_BIT
    | 0x00000002;

/** The roots a line may name, HKR apart. */
const ROOTS = new Map([
    ['hkcr', HKEY_CLASSES_ROOT], ['hkcu', HKEY_CURRENT_USER],
    ['hklm', HKEY_LOCAL_MACHINE], ['hku', HKEY_USERS],
]);

/**
 * A number as strtoul reads it with base 0: `0x` hexadecimal, a leading zero
 * octal, decimal otherwise, up to the first character that is none of those;
 * nothing readable is zero.
 *
 * @param {string} text
 */
export const infNumber = text=>{
    const trimmed = text.trim();
    const sign = trimmed.startsWith('-') ? -1 : 1;
    const digits = trimmed.replace(/^[-+]/, '');
    const hex = /^0x([0-9a-f]*)/i.exec(digits);
    const octal = /^0([0-7]*)/.exec(digits);
    const decimal = /^[0-9]*/.exec(digits);
    const value = hex ? parseInt(hex[1] || '0', 16)
        : octal ? parseInt(octal[1] || '0', 8)
            : parseInt(decimal?.[0] || '0', 10);
    return (sign * (Number.isFinite(value) ? value : 0)) >>> 0;
};

/** @param {string} text @returns {Uint8Array} the ANSI page's bytes, terminated */
const sz = text=>encodeAnsi(`${text}\0`);

/** @param {string[]} strings @returns {Uint8Array} each terminated, and the list too */
const multiSz = strings=>encodeAnsi(`${strings.map(text=>`${text}\0`).join('')}\0`);

/** @param {Uint8Array} data @returns {string[]} */
const multiSzStrings = data=>decodeAnsi(data).split('\0').filter(text=>text !== '');

/**
 * Deletes a key and everything under it, deepest first, as the hive refuses
 * a key that still has subkeys.
 *
 * @param {Hive} hive @param {any} parent @param {string} path
 */
const removeTree = (hive, parent, path)=>{
    const key = hive.open(parent, path);
    if (!key)
    {
        return;
    }
    for (const child of hive.subkeys(key))
    {
        removeTree(hive, key, child);
    }
    hive.remove(parent, path);
};

/**
 * @typedef {Object} RegistryOptions
 * @property {any} [relativeRoot]  The key HKR stands for; without one an HKR line is skipped.
 * @property {(value: string) => string} [expand]
 *           What a field becomes past the parser's substitutions: setupapi's
 *           user DIRIDs, set after the INF was opened.
 * @property {(detail: string) => void} [divergence]
 */

/**
 * One line of an AddReg or DelReg section.
 *
 * @param {Hive} hive @param {InfLine} line @param {boolean} deleting
 * @param {RegistryOptions} options
 * @returns {number | void} an error that ends the install
 */
function applyLine(hive, line, deleting, options){
    // A registry line has a key only when it is a lone field -- the key and
    // the field both -- since its first comma comes before any `=`.
    const fields = (line.key === null || (line.fields.length === 1 && line.fields[0] === line.key)
        ? line.fields : [line.key, ...line.fields]).map(options.expand ?? (value=>value));
    const rootName = (fields[0] ?? '').trim().toLowerCase();
    const root = rootName === 'hkr' ? options.relativeRoot ?? null
        : ROOTS.has(rootName) ? hive.root(/** @type {number} */ (ROOTS.get(rootName))) : null;
    if (!root)
    {
        options.divergence?.(`line ${line.line}: the root ${fields[0] ?? ''} is none this`
            + ' install has; the line is skipped');
        return;
    }
    const subkey = fields[1] ?? '';
    const name = fields[2] ?? '';
    const flags = (infNumber(fields[3] ?? '') | (deleting ? FLG_ADDREG_DELREG_BIT : 0)) >>> 0;

    if (deleting || (flags & FLG_ADDREG_DELVAL) !== 0)
    {
        const key = hive.open(root, subkey);
        if (!key)
        {
            return;
        }
        if (name === '' || (flags & FLG_ADDREG_KEYONLY_COMMON) !== 0)
        {
            removeTree(hive, root, subkey);
            return;
        }
        if ((flags & FLG_DELREG_MULTI_SZ_DELSTRING) === FLG_DELREG_MULTI_SZ_DELSTRING)
        {
            const value = hive.getValue(key, name);
            if (value && value.type === REG_MULTI_SZ)
            {
                const doomed = (fields[4] ?? '').toLowerCase();
                hive.setValue(key, name, REG_MULTI_SZ, multiSz(multiSzStrings(value.data)
                    .filter(text=>text.toLowerCase() !== doomed)));
            }
            return;
        }
        hive.deleteValue(key, name);
        return;
    }

    const key = (flags & FLG_ADDREG_OVERWRITEONLY) !== 0
        ? hive.open(root, subkey) : hive.create(root, subkey).key;
    if (!key || (flags & (FLG_ADDREG_KEYONLY | FLG_ADDREG_KEYONLY_COMMON)) !== 0)
    {
        return;
    }
    if ((flags & (FLG_ADDREG_NOCLOBBER | FLG_ADDREG_OVERWRITEONLY)) !== 0)
    {
        const exists = hive.getValue(key, name) !== null;
        if ((exists && (flags & FLG_ADDREG_NOCLOBBER) !== 0)
            || (!exists && (flags & FLG_ADDREG_OVERWRITEONLY) !== 0))
        {
            return;
        }
    }
    const kind = (flags & FLG_ADDREG_TYPE_MASK) >>> 0;
    const type = kind === 0 ? REG_SZ
        : kind === FLG_ADDREG_TYPE_MULTI_SZ ? REG_MULTI_SZ
            : kind === FLG_ADDREG_TYPE_EXPAND_SZ ? REG_EXPAND_SZ
                : kind === FLG_ADDREG_TYPE_BINARY ? REG_BINARY
                    : kind === FLG_ADDREG_TYPE_DWORD ? REG_DWORD
                        : kind === FLG_ADDREG_TYPE_NONE ? REG_NONE
                            : kind >>> 16;
    const values = fields.slice(4);
    if ((flags & FLG_ADDREG_BINVALUETYPE) === 0 || (type === REG_DWORD && values.length === 1))
    {
        if (type === REG_DWORD)
        {
            const data = new Uint8Array(4);
            new DataView(data.buffer).setUint32(0, infNumber(values[0] ?? ''), true);
            hive.setValue(key, name, REG_DWORD, data);
            return;
        }
        if (type === REG_MULTI_SZ)
        {
            const strings = values.filter(text=>text !== '');
            if ((flags & FLG_ADDREG_APPEND) !== 0)
            {
                const existing = hive.getValue(key, name);
                if (existing && existing.type !== REG_MULTI_SZ)
                {
                    return ERROR_INVALID_DATA;
                }
                const had = existing ? multiSzStrings(existing.data) : [];
                const lower = new Set(had.map(text=>text.toLowerCase()));
                hive.setValue(key, name, REG_MULTI_SZ, multiSz([...had,
                    ...strings.filter(text=>!lower.has(text.toLowerCase()))]));
                return;
            }
            hive.setValue(key, name, REG_MULTI_SZ, multiSz(strings));
            return;
        }
        hive.setValue(key, name, type, sz(values[0] ?? ''));
        return;
    }
    hive.setValue(key, name, type, Uint8Array.from(values.filter(text=>text.trim() !== '')
        .map(text=>parseInt(text.trim(), 16) & 0xff)));
}

/**
 * The sections a directive of an install section names, in the order named,
 * across every line of it.
 *
 * @param {Inf} inf @param {import('./inf.js').InfSection} section @param {string} directive
 */
const namedSections = (inf, section, directive)=>section.lines
    .filter(line=>line.key?.toLowerCase() === directive)
    .flatMap(line=>line.fields)
    .map(name=>name.trim())
    .filter(name=>name !== '')
    .map(name=>inf.section(name))
    .filter(found=>found !== null);

/**
 * Carries out an install section's DelReg and then its AddReg sections. A
 * section a directive names that the INF does not have is passed over, as
 * setupapi passes it over.
 *
 * @param {Hive} hive @param {Inf} inf @param {import('./inf.js').InfSection} section
 * @param {RegistryOptions} [options]
 * @returns {number} ERROR_SUCCESS, or the error the line that ended it met
 */
export function installRegistry(hive, inf, section, options = {}){
    for (const [directive, deleting] of /** @type {const} */ ([['delreg', true],
        ['addreg', false]]))
    {
        for (const named of namedSections(inf, section, directive))
        {
            for (const line of /** @type {import('./inf.js').InfSection} */ (named).lines)
            {
                const error = applyLine(hive, line, deleting, options);
                if (error)
                {
                    return error;
                }
            }
        }
    }
    return ERROR_SUCCESS;
}
