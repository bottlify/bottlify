/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * reg.exe: the registry from the command line, which installers' custom
 * actions and batch files call by name -- `REG DELETE "HKLM\SOFTWARE\Vendor"
 * /f`, `reg add HKCU\Software\X /v Name /t REG_DWORD /d 1 /f`.
 *
 *   reg add    <key> [/v name | /ve] [/t type] [/s separator] [/d data] [/f] [/reg:32|64]
 *   reg delete <key> [/v name | /ve | /va] [/f] [/reg:32|64]
 *   reg query  <key> [/v name | /ve] [/s] [/reg:32|64]
 *
 * A key is named from its root, by the short name or the long one (HKLM,
 * HKEY_LOCAL_MACHINE); a remote machine's is refused. The work is done through
 * advapi32 as the program calls it, so a key reg.exe writes is the key every
 * other process of the run reads. What it has to say goes to its standard
 * output in the console's code page, in reg.exe's own words, and its exit code
 * is 0 for success and 1 for anything else. Without /f, a delete and an
 * overwrite ask on standard input first, as reg.exe asks, and anything but an
 * answer starting with Y leaves the registry as it was.
 *
 * Of the query's filters only /s (every subkey below) is read; /f, /k, /d, /c,
 * /e, /t, /z and /se are refused as syntax this program does not take, which
 * is said rather than a search answered wrongly.
 */

import { argumentsOf, splitArguments } from './command-line.js';

export const REG_EXIT = Object.freeze({ SUCCESS: 0, FAILURE: 1 });

const ROOTS = Object.freeze({
    HKLM: 0x80000002, HKEY_LOCAL_MACHINE: 0x80000002,
    HKCU: 0x80000001, HKEY_CURRENT_USER: 0x80000001,
    HKCR: 0x80000000, HKEY_CLASSES_ROOT: 0x80000000,
    HKU: 0x80000003, HKEY_USERS: 0x80000003,
    HKCC: 0x80000005, HKEY_CURRENT_CONFIG: 0x80000005,
});
/** @type {Readonly<Record<number, string>>} */
const LONG_NAMES = Object.freeze({ 0x80000002: 'HKEY_LOCAL_MACHINE',
    0x80000001: 'HKEY_CURRENT_USER', 0x80000000: 'HKEY_CLASSES_ROOT', 0x80000003: 'HKEY_USERS',
    0x80000005: 'HKEY_CURRENT_CONFIG' });

/** The value types reg.exe takes by name, and their numbers. */
export const REG_TYPES = Object.freeze({ REG_NONE: 0, REG_SZ: 1, REG_EXPAND_SZ: 2,
    REG_BINARY: 3, REG_DWORD: 4, REG_DWORD_BIG_ENDIAN: 5, REG_MULTI_SZ: 7, REG_QWORD: 11 });
const TYPE_NAMES = Object.freeze(Object.fromEntries(Object.entries(REG_TYPES)
    .map(([name, type])=>[type, name])));

const KEY_READ = 0x20019;
const KEY_ALL_ACCESS = 0xf003f;
const KEY_WOW64_64KEY = 0x100;
const KEY_WOW64_32KEY = 0x200;
const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;

const SYNTAX = 'ERROR: Invalid syntax.\r\nType "REG /?" for usage.\r\n';
const NOT_FOUND = 'ERROR: The system was unable to find the specified registry key or value.\r\n';
const DONE = 'The operation completed successfully.\r\n';
const CANCELLED = 'The operation was cancelled by the user.\r\n';

/**
 * @typedef {Object} RegPlan
 * @property {'add' | 'delete' | 'query'} operation
 * @property {number} root
 * @property {string} path      Below the root, without a leading or trailing backslash.
 * @property {string} keyName   As reg.exe prints it: the root's long name and the path.
 * @property {string | null} value  /v's name, '' for /ve, null for neither.
 * @property {boolean} allValues    /va.
 * @property {number} type
 * @property {string} separator
 * @property {string | null} data
 * @property {boolean} force
 * @property {boolean} recurse      /s on a query.
 * @property {number} view          KEY_WOW64_32KEY or _64KEY, or 0.
 */

/**
 * What a reg command line asks for, or why it is refused: the operation and
 * the key first, then the options, opened with `/` or `-` and read without
 * regard to case, each taking the argument after it where it has one.
 *
 * @param {string} line  The arguments after argv[0].
 * @returns {RegPlan | { error: string }}
 */
export function parseReg(line){
    const words = splitArguments(line).map(({ text })=>text);
    const operation = (words.shift() ?? '').toLowerCase();
    if (operation !== 'add' && operation !== 'delete' && operation !== 'query')
    {
        return { error: SYNTAX };
    }
    const key = words.shift();
    if (key === undefined)
    {
        return { error: SYNTAX };
    }
    if (key.startsWith('\\\\'))
    {
        return { error: 'ERROR: Remote registry access is not supported here.\r\n' };
    }
    const cut = key.indexOf('\\');
    const rootName = (cut < 0 ? key : key.slice(0, cut)).toUpperCase();
    const root = /** @type {Record<string, number>} */ (ROOTS)[rootName];
    if (root === undefined)
    {
        return { error: 'ERROR: Invalid key name.\r\nType "REG /?" for usage.\r\n' };
    }
    const path = (cut < 0 ? '' : key.slice(cut + 1)).replace(/\\+$/, '');
    /** @type {RegPlan} */
    const plan = { operation, root, path,
        keyName: path ? `${LONG_NAMES[root]}\\${path}` : LONG_NAMES[root],
        value: null, allValues: false, type: REG_TYPES.REG_SZ, separator: '\\0', data: null,
        force: false, recurse: false, view: 0 };
    /** @type {Set<string>} */
    const seen = new Set();
    while (words.length > 0)
    {
        const word = /** @type {string} */ (words.shift());
        if (!/^[/-]/.test(word))
        {
            return { error: SYNTAX };
        }
        const option = word.slice(1).toLowerCase();
        const taken = option === 'v' || option === 've' || option === 'va' ? 'value' : option;
        if (seen.has(taken))
        {
            return { error: SYNTAX };
        }
        seen.add(taken);
        /** @returns {string | null} */
        const argument = ()=>words.shift() ?? null;
        const allowed = {
            add: ['v', 've', 't', 's', 'd', 'f', 'reg:32', 'reg:64'],
            delete: ['v', 've', 'va', 'f', 'reg:32', 'reg:64'],
            query: ['v', 've', 's', 'reg:32', 'reg:64'],
        }[operation];
        if (!allowed.includes(option))
        {
            return { error: SYNTAX };
        }
        switch (option)
        {
            case 'v': {
                const name = argument();
                if (name === null)
                {
                    return { error: SYNTAX };
                }
                plan.value = name;
                break;
            }
            case 've':
                plan.value = '';
                break;
            case 'va':
                plan.allValues = true;
                break;
            case 't': {
                const type = /** @type {Record<string, number>} */ (REG_TYPES)[
                    (argument() ?? '').toUpperCase()];
                if (type === undefined)
                {
                    return { error: 'ERROR: Invalid syntax. Specify a valid type for /t.\r\n' };
                }
                plan.type = type;
                break;
            }
            case 's':
                if (operation === 'query')
                {
                    plan.recurse = true;
                }
                else
                {
                    const separator = argument();
                    if (separator === null || separator.length !== 1)
                    {
                        return { error: SYNTAX };
                    }
                    plan.separator = separator;
                }
                break;
            case 'd':
                plan.data = argument();
                if (plan.data === null)
                {
                    return { error: SYNTAX };
                }
                break;
            case 'f':
                plan.force = true;
                break;
            default:
                plan.view = option === 'reg:32' ? KEY_WOW64_32KEY : KEY_WOW64_64KEY;
        }
    }
    if (operation !== 'query' && path === '')
    {
        return { error: 'ERROR: Invalid key name.\r\nType "REG /?" for usage.\r\n' };
    }
    return plan;
}

/**
 * A value's bytes from the text /d gives, for its type, or null for text the
 * type cannot take: numbers in decimal or with 0x, binary as hex digits, a
 * multi-string split at the separator and closed by an empty string.
 *
 * @param {number} type @param {string} data @param {string} separator
 * @returns {Uint8Array | null}
 */
export function valueBytes(type, data, separator){
    /** @param {string} text */
    const utf16 = text=>new Uint8Array(new Uint16Array([...text].flatMap(unit=>{
        const code = unit.codePointAt(0) ?? 0;
        return code > 0xffff ? [0xd800 + (code - 0x10000 >> 10), 0xdc00 + (code & 0x3ff)]
            : [code];
    })).buffer);
    switch (type)
    {
        case REG_TYPES.REG_SZ:
        case REG_TYPES.REG_EXPAND_SZ:
            return utf16(`${data}\0`);
        case REG_TYPES.REG_MULTI_SZ: {
            const items = data === '' ? [] : data.split(separator);
            return utf16(`${items.map(item=>`${item}\0`).join('')}\0`);
        }
        case REG_TYPES.REG_DWORD:
        case REG_TYPES.REG_DWORD_BIG_ENDIAN:
        case REG_TYPES.REG_QWORD: {
            const text = data === '' ? '0' : data.trim();
            if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(text))
            {
                return null;
            }
            const number = BigInt(text);
            const width = type === REG_TYPES.REG_QWORD ? 64 : 32;
            if (number >= 1n << BigInt(width))
            {
                return null;
            }
            const bytes = new Uint8Array(width / 8);
            const view = new DataView(bytes.buffer);
            if (width === 64)
            {
                view.setBigUint64(0, number, true);
            }
            else
            {
                view.setUint32(0, Number(number), type === REG_TYPES.REG_DWORD);
            }
            return bytes;
        }
        default: {
            if (!/^([0-9a-f]{2})*$/i.test(data))
            {
                return null;
            }
            return Uint8Array.from(data.match(/../g) ?? [], pair=>parseInt(pair, 16));
        }
    }
}

/**
 * A value as reg query prints it: strings as they are, a multi-string's items
 * joined by a literal \0, numbers in hex, anything else as hex digits.
 *
 * @param {number} type @param {Uint8Array} bytes
 */
export function shownValue(type, bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = ()=>{
        const units = new Uint16Array(bytes.buffer.slice(bytes.byteOffset,
            bytes.byteOffset + (bytes.byteLength & ~1)));
        return String.fromCharCode(...units);
    };
    switch (type)
    {
        case REG_TYPES.REG_SZ:
        case REG_TYPES.REG_EXPAND_SZ:
            return text().replace(/\0.*$/s, '');
        case REG_TYPES.REG_MULTI_SZ:
            return text().replace(/\0\0.*$/s, '').replace(/\0$/, '').split('\0').join('\\0');
        case REG_TYPES.REG_DWORD:
        case REG_TYPES.REG_DWORD_BIG_ENDIAN:
            return bytes.length >= 4
                ? `0x${view.getUint32(0, type === REG_TYPES.REG_DWORD).toString(16)}` : '';
        case REG_TYPES.REG_QWORD:
            return bytes.length >= 8 ? `0x${view.getBigUint64(0, true).toString(16)}` : '';
        default:
            return [...bytes].map(byte=>byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    }
}

/**
 * Runs reg over the process's command line.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runReg(context){
    /** @param {string} name @param {number[]} args */
    const advapi = (name, args)=>context.call('ADVAPI32.dll', name, args);
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>context.call('KERNEL32.dll', name, args);
    /** @param {number} at */
    const dword = at=>new DataView(context.read(at, 4).buffer).getUint32(0, true);
    /** @param {string} text */
    const say = async text=>{
        const bytes = new TextEncoder().encode(text);
        const output = await kernel32('GetStdHandle', [STD_OUTPUT_HANDLE]);
        await kernel32('WriteFile', [output, context.bytes(bytes), bytes.length,
            context.block(4), 0]);
    };
    /** @param {string} question */
    const confirmed = async question=>{
        await say(`${question} (Yes/No)? `);
        const input = await kernel32('GetStdHandle', [STD_INPUT_HANDLE]);
        const buffer = context.block(64);
        const read = context.block(4);
        if (!await kernel32('ReadFile', [input, buffer, 64, read, 0]))
        {
            return false;
        }
        return /^\s*y/i.test(new TextDecoder().decode(context.read(buffer, dword(read))));
    };
    /** @param {number} code */
    const failure = async code=>{
        await say(code === ERROR_ACCESS_DENIED ? 'ERROR: Access is denied.\r\n'
            : code === ERROR_FILE_NOT_FOUND ? NOT_FOUND
                : `ERROR: The operation failed with error ${code}.\r\n`);
        return REG_EXIT.FAILURE;
    };

    const plan = parseReg(argumentsOf(context.commandLine));
    if ('error' in plan)
    {
        await say(plan.error);
        return REG_EXIT.FAILURE;
    }
    /** @param {number} access @returns {Promise<[number, number]>} the code and the key */
    const open = async access=>{
        const out = context.block(4);
        const code = await advapi('RegOpenKeyExW', [plan.root, context.wide(plan.path), 0,
            access | plan.view, out]);
        return [code, code === ERROR_SUCCESS ? dword(out) : 0];
    };
    /**
     * A value's type and bytes, by its name.
     *
     * @param {number} key @param {string} name
     * @returns {Promise<{ code: number, type: number, bytes: Uint8Array }>}
     */
    const valueOf = async(key, name)=>{
        const type = context.block(4);
        const length = context.block(4);
        context.write(length, new Uint8Array(4));
        let code = await advapi('RegQueryValueExW', [key, context.wide(name), 0, type, 0,
            length]);
        if (code !== ERROR_SUCCESS)
        {
            return { code, type: 0, bytes: new Uint8Array(0) };
        }
        const size = dword(length);
        const data = context.block(Math.max(size, 1));
        code = await advapi('RegQueryValueExW', [key, context.wide(name), 0, type, data,
            length]);
        return { code, type: dword(type), bytes: context.read(data, dword(length)) };
    };
    /**
     * Every value's name under a key, in the registry's order.
     *
     * @param {number} key @returns {Promise<string[]>}
     */
    const valueNames = async key=>{
        const names = [];
        const name = context.block(2 * 16384);
        const length = context.block(4);
        for (let index = 0; ; index++)
        {
            context.write(length, new Uint8Array(new Uint32Array([16384]).buffer));
            const code = await advapi('RegEnumValueW', [key, index, name, length, 0, 0, 0, 0]);
            if (code === ERROR_NO_MORE_ITEMS)
            {
                return names;
            }
            if (code !== ERROR_SUCCESS && code !== ERROR_MORE_DATA)
            {
                return names;
            }
            names.push(String.fromCharCode(...new Uint16Array(context.read(name,
                dword(length) * 2).slice().buffer)));
        }
    };
    /**
     * Every subkey's name under a key.
     *
     * @param {number} key @returns {Promise<string[]>}
     */
    const subkeyNames = async key=>{
        const names = [];
        const name = context.block(2 * 256);
        const length = context.block(4);
        for (let index = 0; ; index++)
        {
            context.write(length, new Uint8Array(new Uint32Array([256]).buffer));
            const code = await advapi('RegEnumKeyExW', [key, index, name, length, 0, 0, 0, 0]);
            if (code !== ERROR_SUCCESS)
            {
                return names;
            }
            names.push(String.fromCharCode(...new Uint16Array(context.read(name,
                dword(length) * 2).slice().buffer)));
        }
    };
    /** @param {string} name @param {number} type @param {Uint8Array} bytes */
    const line = (name, type, bytes)=>`    ${name === '' ? '(Default)' : name}    `
        + `${TYPE_NAMES[type] ?? `REG_UNKNOWN(${type})`}    ${shownValue(type, bytes)}\r\n`;

    if (plan.operation === 'add')
    {
        const out = context.block(4);
        const code = await advapi('RegCreateKeyExW', [plan.root, context.wide(plan.path), 0, 0,
            0, KEY_ALL_ACCESS | plan.view, 0, out, 0]);
        if (code !== ERROR_SUCCESS)
        {
            return failure(code);
        }
        const key = dword(out);
        try
        {
            const name = plan.value ?? (plan.data !== null ? '' : null);
            if (name === null)
            {
                await say(DONE);
                return REG_EXIT.SUCCESS;
            }
            const bytes = valueBytes(plan.type, plan.data ?? '', plan.separator);
            if (bytes === null)
            {
                await say('ERROR: Invalid syntax. Specify valid data for /d.\r\n');
                return REG_EXIT.FAILURE;
            }
            if (!plan.force && (await valueOf(key, name)).code === ERROR_SUCCESS
                && !await confirmed(`Value ${name === '' ? '(Default)' : name} exists, overwrite`))
            {
                await say(CANCELLED);
                return REG_EXIT.FAILURE;
            }
            const set = await advapi('RegSetValueExW', [key, context.wide(name), 0, plan.type,
                context.bytes(bytes), bytes.length]);
            if (set !== ERROR_SUCCESS)
            {
                return failure(set);
            }
            await say(DONE);
            return REG_EXIT.SUCCESS;
        }
        finally
        {
            await advapi('RegCloseKey', [key]);
        }
    }

    if (plan.operation === 'delete')
    {
        const [code, key] = await open(KEY_ALL_ACCESS);
        if (code !== ERROR_SUCCESS)
        {
            return failure(code);
        }
        try
        {
            const what = plan.value !== null
                ? `value ${plan.value === '' ? '(Default)' : plan.value}`
                : plan.allValues ? `all values under ${plan.keyName}` : `key ${plan.keyName}`;
            if (plan.value !== null && (await valueOf(key, plan.value)).code !== ERROR_SUCCESS)
            {
                return failure(ERROR_FILE_NOT_FOUND);
            }
            if (!plan.force && !await confirmed(`Delete the registry ${what}`))
            {
                await say(CANCELLED);
                return REG_EXIT.FAILURE;
            }
            if (plan.value !== null)
            {
                const removed = await advapi('RegDeleteValueW', [key, context.wide(plan.value)]);
                if (removed !== ERROR_SUCCESS)
                {
                    return failure(removed);
                }
            }
            else if (plan.allValues)
            {
                for (const name of await valueNames(key))
                {
                    await advapi('RegDeleteValueW', [key, context.wide(name)]);
                }
            }
            else
            {
                await advapi('RegCloseKey', [key]);
                const removed = await advapi('RegDeleteTreeW', [plan.root,
                    context.wide(plan.path)]);
                if (removed !== ERROR_SUCCESS)
                {
                    return failure(removed);
                }
                await say(DONE);
                return REG_EXIT.SUCCESS;
            }
            await say(DONE);
            return REG_EXIT.SUCCESS;
        }
        finally
        {
            if (plan.value !== null || plan.allValues)
            {
                await advapi('RegCloseKey', [key]);
            }
        }
    }

    const [code, key] = await open(KEY_READ);
    if (code !== ERROR_SUCCESS)
    {
        return failure(code);
    }
    try
    {
        if (plan.value !== null)
        {
            const value = await valueOf(key, plan.value);
            if (value.code !== ERROR_SUCCESS)
            {
                return failure(value.code);
            }
            await say(`\r\n${plan.keyName}\r\n${line(plan.value, value.type, value.bytes)}\r\n`);
            return REG_EXIT.SUCCESS;
        }
        /** @param {number} at @param {string} name @returns {Promise<string>} */
        const listing = async(at, name)=>{
            let text = `${name}\r\n`;
            for (const value of await valueNames(at))
            {
                const read = await valueOf(at, value);
                text += line(value, read.type, read.bytes);
            }
            const subkeys = await subkeyNames(at);
            if (!plan.recurse)
            {
                return `${text}\r\n${subkeys.map(sub=>`${name}\\${sub}\r\n`).join('')}`;
            }
            text += '\r\n';
            for (const sub of subkeys)
            {
                const out = context.block(4);
                if (await advapi('RegOpenKeyExW', [at, context.wide(sub), 0, KEY_READ | plan.view,
                    out]) === ERROR_SUCCESS)
                {
                    text += await listing(dword(out), `${name}\\${sub}`);
                    await advapi('RegCloseKey', [dword(out)]);
                }
            }
            return text;
        };
        await say(`\r\n${await listing(key, plan.keyName)}`);
        return REG_EXIT.SUCCESS;
    }
    finally
    {
        await advapi('RegCloseKey', [key]);
    }
}
