/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a file is opened with: its type's class under HKEY_CLASSES_ROOT, the
 * verb's command under the class's `shell` key, and the command line made
 * from that command and the caller's file and parameters.
 *
 * The command is a template: `%1` and `%L` are the file, `%2` to `%9` the
 * caller's parameters one by one, `%*` all of them as given, `%~n` the
 * parameters from the nth on. The parameters are split by the shell's own
 * rules, which are not the C runtime's: only a space separates them, a
 * backslash is an ordinary character, a run of quotes is halved and an odd
 * one ends the parameter, and an unclosed quoted one is lost (Wine's
 * test_argify, against Windows).
 */

/**
 * @typedef {Object} Parameter
 * @property {string} text  What the parameter is, its quotes resolved.
 * @property {number} end   Where in the raw string it ends, its closing quote included.
 */

/**
 * The caller's parameters, as the shell splits them.
 *
 * @param {string} raw
 * @returns {Parameter[]}
 */
export function splitParameters(raw){
    /** @type {Parameter[]} */
    const out = [];
    let at = 0;
    while (at < raw.length)
    {
        while (raw[at] === ' ')
        {
            at++;
        }
        if (at >= raw.length)
        {
            break;
        }
        const quoted = raw[at] === '"';
        if (quoted)
        {
            at++;
        }
        let text = '';
        let closed = !quoted;
        while (at < raw.length)
        {
            const c = raw[at];
            if (c === '"')
            {
                let run = 0;
                while (raw[at] === '"')
                {
                    run++;
                    at++;
                }
                text += '"'.repeat(Math.floor(run / 2));
                if (run % 2 === 1)
                {
                    closed = true;
                    break;
                }
                continue;
            }
            if (c === ' ' && !quoted)
            {
                break;
            }
            text += c;
            at++;
        }
        if (!closed)
        {
            // A quoted parameter that never closes takes the rest with it.
            break;
        }
        out.push({ text, end: at });
    }
    return out;
}

/**
 * A command template filled in for a file and its parameters. A directive
 * the shell does not know loses its percent sign, but one with a tilde
 * stays as it is.
 *
 * @param {string} template @param {string} file @param {string} raw
 */
export function argify(template, file, raw){
    const parameters = splitParameters(raw);
    let out = '';
    for (let at = 0; at < template.length; at++)
    {
        const c = template[at];
        if (c !== '%' || at + 1 >= template.length)
        {
            out += c;
            continue;
        }
        const next = template[at + 1];
        if (next === '1' || next === 'L' || next === 'l')
        {
            out += file;
            at++;
        }
        else if (next >= '2' && next <= '9')
        {
            out += parameters[Number(next) - 2]?.text ?? '';
            at++;
        }
        else if (next === '*')
        {
            out += raw;
            at++;
        }
        else if (next === '~' && /[2-9]/.test(template[at + 2] ?? ''))
        {
            const n = Number(template[at + 2]);
            const from = n === 2 ? 0 : parameters[n - 3]?.end;
            out += from === undefined ? '' : raw.slice(from);
            at += 2;
        }
        else if (next === '~')
        {
            out += '%~';
            at++;
        }
        else
        {
            out += next;
            at++;
        }
    }
    return out;
}

/**
 * Whether a template names the file itself; one that does not has it put at
 * its end.
 *
 * @param {string} template
 */
export const namesFile = template=>/%[1lL*~2-9]/.test(template);

/**
 * The path a `file:` URL names -- its slashes backslashes, a `|` after a
 * drive its colon, its escapes undone -- and anything else as it is.
 * Up to four slashes may lead the drive, or `//localhost/`; five, or
 * another host, name nothing here: null (Wine's test_fileurls).
 *
 * @param {string} text
 * @returns {string | null}
 */
export const pathOfFileUrl = text=>{
    const url = /^file:(\/*)(.*)$/i.exec(text);
    if (!url)
    {
        return text;
    }
    const local = url[1].length === 2 && /^localhost\//i.test(url[2]);
    const rest = local ? url[2].slice('localhost/'.length) : url[2];
    const drive = /^([A-Za-z])[:|]([\\/].*)?$/.exec(rest);
    if (url[1].length > 4 || !drive)
    {
        return null;
    }
    const path = (drive[2] ?? '\\').replace(/\//g, '\\')
        .replace(/%([0-9A-Fa-f]{2})/g, (_, hex)=>String.fromCharCode(parseInt(hex, 16)));
    return `${drive[1]}:${path}`;
};

const HKEY_CLASSES_ROOT = 0x80000000;
const KEY_READ = 0x20019;
const ERROR_SUCCESS = 0;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;

/**
 * @typedef {Object} AssociationHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} [free]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} library
 */

/**
 * The classes' registry, read through advapi32 as a program reads it, so a
 * class a program registered a moment ago is the one found.
 *
 * @param {AssociationHost} host
 */
export function createAssociations(host){
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>{
        const answer = host.library('ADVAPI32.dll')?.[name]?.handler(args);
        return typeof answer === 'number' ? answer >>> 0 : -1;
    };
    /** @param {Uint8Array} bytes */
    const u32 = bytes=>new DataView(bytes.slice().buffer).getUint32(0, true);
    /** @param {string} text */
    const ansi = text=>Uint8Array.from(`${text}\0`, c=>c.charCodeAt(0) & 0xff);
    /** @param {Uint8Array} bytes */
    const text = bytes=>{
        const end = bytes.indexOf(0);
        return String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end));
    };

    /**
     * What `body` makes of the class key at `path`, opened for it; null for
     * a key that is not there.
     *
     * @template T
     * @param {string} path @param {(key: number, scratch: number) => T} body
     * @returns {T | null}
     */
    const withKey = (path, body)=>{
        const name = ansi(path);
        const scratch = host.allocate(0x400 + name.length);
        if (!scratch)
        {
            return null;
        }
        try
        {
            host.writeMemory(scratch + 0x400, name);
            if (call('RegOpenKeyExA', [HKEY_CLASSES_ROOT, scratch + 0x400, 0, KEY_READ, scratch])
                !== ERROR_SUCCESS)
            {
                return null;
            }
            const key = u32(host.readMemory(scratch, 4));
            try
            {
                return body(key, scratch);
            }
            finally
            {
                call('RegCloseKey', [key]);
            }
        }
        finally
        {
            host.free?.(scratch);
        }
    };

    /**
     * A key's default string, or null.
     *
     * @param {string} path
     * @returns {{ value: string, expand: boolean } | null}
     */
    const defaultOf = path=>withKey(path, (key, scratch)=>{
        host.writeMemory(scratch + 8, Uint8Array.of(0, 4, 0, 0));
        if (call('RegQueryValueExA', [key, 0, 0, scratch + 4, scratch + 0x200, scratch + 8])
            !== ERROR_SUCCESS)
        {
            return null;
        }
        const type = u32(host.readMemory(scratch + 4, 4));
        if (type !== REG_SZ && type !== REG_EXPAND_SZ)
        {
            return null;
        }
        return { value: text(host.readMemory(scratch + 0x200, 0x200)),
            expand: type === REG_EXPAND_SZ };
    });

    /** @param {string} path @returns {string | null} its first subkey */
    const firstSubkey = path=>withKey(path, (key, scratch)=>(call('RegEnumKeyA',
        [key, 0, scratch + 0x200, 0x100]) === ERROR_SUCCESS
        ? text(host.readMemory(scratch + 0x200, 0x100)) : null));

    /**
     * The command a verb of a class runs, and the verb found: the one asked
     * for, or the class's default verb -- the `shell` key's own value,
     * else `open`, else its first.
     *
     * @param {string} name  The class's key under HKEY_CLASSES_ROOT.
     * @param {string | null} verb
     */
    const commandOf = (name, verb)=>{
        const asked = verb?.trim() || null;
        const chosen = asked ?? (defaultOf(`${name}\\shell`)?.value || null)
            ?? (defaultOf(`${name}\\shell\\open\\command`) ? 'open'
                : firstSubkey(`${name}\\shell`));
        if (chosen === null)
        {
            return null;
        }
        const command = defaultOf(`${name}\\shell\\${chosen}\\command`);
        return command ? { verb: chosen, ...command } : null;
    };

    return {
        /**
         * The class a file's extension names, its own key when it has a
         * shell of its own, or null.
         *
         * @param {string} extension  With its dot.
         */
        classOf: extension=>{
            const named = defaultOf(extension)?.value;
            if (named)
            {
                return named;
            }
            return withKey(`${extension}\\shell`, ()=>extension);
        },
        commandOf,
    };
}
