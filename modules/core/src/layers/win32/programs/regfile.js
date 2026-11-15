/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A registration file (.reg): what regedit imports and `reg import` reads,
 * which setups write and run as `regedit /s settings.reg`.
 *
 * The file opens with its version line - `REGEDIT4`, whose strings are in the
 * ANSI code page, or `Windows Registry Editor Version 5.00`, written as UTF-16,
 * whose strings are UTF-16 - and then holds keys and values:
 *
 *   [HKEY_CURRENT_USER\Software\Vendor]     the key, made where it is not
 *   [-HKEY_CURRENT_USER\Software\Old]       the key and all below it removed
 *   "Name"="text"                           a string; \\ and \" inside it
 *                                           (the key's default value is named `@`)
 *   "Count"=dword:0000002a                  a DWORD, eight hex digits
 *   "Data"=hex:01,02,ff                     binary, a byte a pair
 *   "Path"=hex(2):25,00,...                 any type by number, as bytes
 *   "Gone"=-                                the value removed
 *
 * A line ending in a backslash goes on on the next; a line opening with `;`
 * is a comment. A value before any key, or a key whose root is not one of
 * the registry's, is skipped, as regedit skips it.
 */

import { decodeAnsi } from '../kernel32/locale.js';

/** The registry's roots, by the short name and the long one, as reg and regedit read them. */
export const ROOTS = Object.freeze({
    HKLM: 0x80000002, HKEY_LOCAL_MACHINE: 0x80000002,
    HKCU: 0x80000001, HKEY_CURRENT_USER: 0x80000001,
    HKCR: 0x80000000, HKEY_CLASSES_ROOT: 0x80000000,
    HKU: 0x80000003, HKEY_USERS: 0x80000003,
    HKCC: 0x80000005, HKEY_CURRENT_CONFIG: 0x80000005,
});

const REG_NONE = 0;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_BINARY = 3;
const REG_DWORD = 4;
const REG_MULTI_SZ = 7;

/** The first line of each kind of file, and the width of its strings. */
const VERSION_4 = 'REGEDIT4';
const VERSION_5 = 'Windows Registry Editor Version 5.00';

/**
 * @typedef {{ kind: 'key', root: number, path: string, remove: boolean }
 *     | { kind: 'value', name: string, type: number, data: Uint8Array | null }} RegEntry
 *     A key, or a value of the key before it; `data` null removes the value.
 */

/** @param {string} text */
const utf16 = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
    }
    return bytes;
};

/**
 * A quoted string's text and where it ends, its escapes undone; null for one
 * that does not close.
 *
 * @param {string} line @param {number} at  Just past the opening quote.
 * @returns {{ text: string, end: number } | null}
 */
function quoted(line, at){
    let text = '';
    for (let index = at; index < line.length; index++)
    {
        const char = line[index];
        if (char === '\\' && index + 1 < line.length)
        {
            text += line[++index];
        }
        else if (char === '"')
        {
            return { text, end: index + 1 };
        }
        else
        {
            text += char;
        }
    }
    return null;
}

/**
 * A value's type and bytes from what follows its `=`, or undefined for text
 * no value is written as. A string is stored in the registry's width (UTF-16);
 * hex(n) data are the bytes as written.
 *
 * @param {string} text @param {boolean} ansi  In a REGEDIT4 file.
 * @returns {{ type: number, data: Uint8Array | null } | undefined}
 */
function valueOf(text, ansi){
    if (text === '-')
    {
        return { type: REG_NONE, data: null };
    }
    if (text.startsWith('"'))
    {
        const string = quoted(text, 1);
        return string && text.slice(string.end).trim() === ''
            ? { type: REG_SZ, data: utf16(`${string.text}\0`) } : undefined;
    }
    const dword = /^dword:([0-9a-f]{1,8})$/i.exec(text);
    if (dword)
    {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setUint32(0, parseInt(dword[1], 16), true);
        return { type: REG_DWORD, data };
    }
    const hex = /^hex(?:\(([0-9a-f]+)\))?:([0-9a-f,\s]*)$/i.exec(text);
    if (hex)
    {
        const pairs = hex[2].split(',').map(pair=>pair.trim()).filter(pair=>pair !== '');
        if (!pairs.every(pair=>/^[0-9a-f]{1,2}$/i.test(pair)))
        {
            return undefined;
        }
        const type = hex[1] === undefined ? REG_BINARY : parseInt(hex[1], 16);
        const data = Uint8Array.from(pairs, pair=>parseInt(pair, 16));
        // A REGEDIT4 file spells a string type's bytes in the ANSI code page;
        // the registry keeps them as UTF-16, as regedit stores them.
        return ansi && (type === REG_SZ || type === REG_EXPAND_SZ || type === REG_MULTI_SZ)
            ? { type, data: utf16(decodeAnsi(data)) } : { type, data };
    }
    return undefined;
}

/**
 * What a registration file holds, or why it is not one: its version line
 * first, then each key and value in the order written.
 *
 * @param {string} text  The file decoded: UTF-16 or the ANSI code page.
 * @returns {{ entries: RegEntry[] } | { error: string }}
 */
export function parseRegFile(text){
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    const first = (lines.shift() ?? '').trim();
    if (first !== VERSION_4 && first !== VERSION_5)
    {
        return { error: 'not a registration file' };
    }
    /** @type {RegEntry[]} */
    const entries = [];
    let inKey = false;
    for (let index = 0; index < lines.length; index++)
    {
        let line = lines[index].trim();
        // A value written over several lines, each but the last ending in a
        // backslash.
        while (line.endsWith('\\') && index + 1 < lines.length && !line.startsWith('['))
        {
            line = line.slice(0, -1) + lines[++index].trim();
        }
        if (line === '' || line.startsWith(';'))
        {
            continue;
        }
        if (line.startsWith('['))
        {
            const close = line.lastIndexOf(']');
            const body = line.slice(1, close < 0 ? line.length : close);
            const remove = body.startsWith('-');
            const name = remove ? body.slice(1) : body;
            const cut = name.indexOf('\\');
            const root = /** @type {Record<string, number>} */ (ROOTS)[
                (cut < 0 ? name : name.slice(0, cut)).toUpperCase()];
            inKey = root !== undefined && !remove;
            if (root !== undefined)
            {
                entries.push({ kind: 'key', root, path: cut < 0 ? '' : name.slice(cut + 1)
                    .replace(/\\+$/, ''), remove });
            }
            continue;
        }
        if (!inKey)
        {
            continue;
        }
        let name;
        let rest;
        if (line.startsWith('@'))
        {
            name = '';
            rest = line.slice(1);
        }
        else if (line.startsWith('"'))
        {
            const named = quoted(line, 1);
            if (!named)
            {
                continue;
            }
            name = named.text;
            rest = line.slice(named.end);
        }
        else
        {
            continue;
        }
        rest = rest.trim();
        if (!rest.startsWith('='))
        {
            continue;
        }
        const value = valueOf(rest.slice(1).trim(), first === VERSION_4);
        if (value)
        {
            entries.push({ kind: 'value', name, ...value });
        }
    }
    return { entries };
}

const KEY_ALL_ACCESS = 0xf003f;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;

/**
 * Writes a file's entries into the registry through advapi32, as the program
 * importing it calls it: each key made or removed, each value set or removed
 * in the key before it.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @param {RegEntry[]} entries
 * @returns {Promise<number>}  ERROR_SUCCESS, or the first error a call answered
 */
export async function importRegEntries(context, entries){
    /** @param {string} name @param {number[]} args */
    const advapi = (name, args)=>context.call('ADVAPI32.dll', name, args);
    let key = 0;
    let first = ERROR_SUCCESS;
    /** @param {number} code */
    const note = code=>{
        if (code !== ERROR_SUCCESS && first === ERROR_SUCCESS)
        {
            first = code;
        }
    };
    const close = async()=>{
        if (key !== 0)
        {
            await advapi('RegCloseKey', [key]);
            key = 0;
        }
    };
    for (const entry of entries)
    {
        if (entry.kind === 'key')
        {
            await close();
            if (entry.remove)
            {
                const removed = await advapi('RegDeleteTreeW', [entry.root,
                    context.wide(entry.path)]);
                // A key that was never there is already as the file asks.
                note(removed === ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : removed);
                continue;
            }
            const out = context.block(4);
            const code = await advapi('RegCreateKeyExW', [entry.root, context.wide(entry.path),
                0, 0, 0, KEY_ALL_ACCESS, 0, out, 0]);
            note(code);
            key = code === ERROR_SUCCESS
                ? new DataView(context.read(out, 4).buffer).getUint32(0, true) : 0;
            continue;
        }
        if (key === 0)
        {
            continue;
        }
        if (entry.data === null)
        {
            const removed = await advapi('RegDeleteValueW', [key, context.wide(entry.name)]);
            note(removed === ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : removed);
            continue;
        }
        note(await advapi('RegSetValueExW', [key, context.wide(entry.name), 0, entry.type,
            context.bytes(entry.data), entry.data.length]));
    }
    await close();
    return first;
}
