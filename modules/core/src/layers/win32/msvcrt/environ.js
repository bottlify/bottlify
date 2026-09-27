/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime's environment: a copy of the process's variables the runtime
 * takes as it starts and keeps apart from then on.
 *
 * `getenv` reads the copy, not the process's block -- a variable a program
 * sets with SetEnvironmentVariable is not seen by `getenv` until `_putenv`
 * sets it too -- and `_putenv` changes both. The copy is also an array a
 * program walks: `_environ`, the `NAME=value` strings in the order they were
 * set, which `__getmainargs` hands `main` as its third argument and
 * `getenv` answers a pointer into. A string is not moved while its variable
 * keeps its value, and the first change after start leaves the array
 * `__initenv` holds as it was, making a new one.
 *
 * The wide copy, `_wenviron`, does not exist until a wide call asks for it
 * -- `__wgetmainargs`, `_wgetenv`, `_wputenv` -- and is then made from the
 * narrow copy as it stands, as `__winitenv` is. From then on each change is
 * made to both.
 */

import { EINVAL, ERANGE } from './globals.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { wideStringAt } from './widetext.js';

/** A string is read no further than this. */
const MAX_STRING = 1 << 20;

/**
 * @typedef {Object} EnvironmentHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {(code: number) => void} errno
 * @property {() => Record<string, string>} [environment]
 *     The process's variables as it starts, as GetEnvironmentStrings holds
 *     them. Absent, the runtime starts with none.
 * @property {(name: string, value: string | null) => void} [setVariable]
 *     Where `_putenv` changes the process's own block, as
 *     SetEnvironmentVariable does; null removes. Absent, the change is the
 *     runtime's alone.
 * @property {(name: string) => number} [addressOf]
 *     Where the runtime's own export of that name was placed, zero before it
 *     is: `_environ`, `_wenviron`, `__initenv` and `__winitenv` are
 *     rewritten there as they change. Absent, each keeps the value it was
 *     placed with.
 * @property {(name: string, initial?: number) => number} cell
 *     An int of the runtime's own, for a `__p__` accessor when the export's
 *     own address is not to be had.
 */

/**
 * @typedef {Object} Variable
 * @property {string} name
 * @property {string} value
 * @property {number} narrow  "NAME=value" in the ANSI page, on the heap.
 * @property {number} wide    The same in UTF-16, or zero before the wide copy exists.
 */

/**
 * @param {EnvironmentHost} host
 */
export function createEnvironment(host){
    /** @type {Variable[] | null} */
    let variables = null;
    let environ = 0;
    let initenv = 0;
    let wenviron = 0;
    let winitenv = 0;

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /** @param {Uint8Array} bytes */
    const place = bytes=>{
        const address = host.allocate(bytes.length);
        if (address !== 0)
        {
            host.writeMemory(address, bytes);
        }
        return address;
    };

    /** @param {string} text */
    const narrowString = text=>place(encodeAnsi(`${text}\0`));

    /** @param {string} text */
    const wideString = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        return place(bytes);
    };

    /** A null-terminated array of the strings. @param {number[]} pointers */
    const array = pointers=>{
        const bytes = new Uint8Array((pointers.length + 1) * 4);
        const view = new DataView(bytes.buffer);
        pointers.forEach((pointer, index)=>view.setUint32(index * 4, pointer >>> 0, true));
        return place(bytes);
    };

    /**
     * Each variable as the arrays and accessors report it, wherever it is
     * kept: the export's own address where it is known, and the cell a
     * `__p__` accessor hands out.
     */
    const publish = ()=>{
        for (const [name, value] of /** @type {[string, number][]} */ ([['_environ', environ],
            ['_wenviron', wenviron], ['__initenv', initenv], ['__winitenv', winitenv]]))
        {
            const at = host.addressOf?.(name) ?? 0;
            if (at !== 0)
            {
                writeU32(at, value);
            }
            writeU32(host.cell(name), value);
        }
    };

    const start = ()=>{
        if (variables)
        {
            return variables;
        }
        variables = Object.entries(host.environment?.() ?? {}).map(([name, value])=>({
            name, value, narrow: narrowString(`${name}=${value}`), wide: 0,
        }));
        environ = array(variables.map(variable=>variable.narrow));
        initenv = environ;
        return variables;
    };

    /** The wide copy, made from the narrow one as it stands when first asked for. */
    const startWide = ()=>{
        const all = start();
        if (wenviron === 0)
        {
            for (const variable of all)
            {
                variable.wide = wideString(`${variable.name}=${variable.value}`);
            }
            wenviron = array(all.map(variable=>variable.wide));
            winitenv = wenviron;
            publish();
        }
        return all;
    };

    /**
     * A name as the narrow copy holds it, in the ANSI page: a character the
     * page has no byte for is the one it stands in with.
     *
     * @param {string} name
     */
    const narrowName = name=>decodeAnsi(encodeAnsi(name));

    /**
     * Where a variable is, found without regard to case: a narrow name is
     * matched against the names as the narrow copy holds them.
     *
     * @param {string} name @param {boolean} [wide]
     */
    const find = (name, wide = false)=>{
        const wanted = name.toUpperCase();
        return start().findIndex(variable=>
            (wide ? variable.name : narrowName(variable.name)).toUpperCase() === wanted);
    };

    /**
     * Sets or removes one variable, in the runtime's copies and the
     * process's block: a new one at the end, a changed one where it was.
     *
     * @param {string} name @param {string} value  Empty removes.
     * @param {boolean} [wideName]  The name came wide, and is matched so.
     */
    const set = (name, value, wideName = false)=>{
        const all = start();
        const index = find(name, wideName);
        const wide = wenviron !== 0;
        // The strings a changed variable leaves are left where they are: the
        // arrays `__initenv` and `__winitenv` hold may still point at them.
        if (index >= 0)
        {
            all.splice(index, 1);
        }
        if (value !== '')
        {
            const text = `${name}=${value}`;
            const variable = { name, value, narrow: narrowString(text),
                wide: wide ? wideString(text) : 0 };
            all.splice(index >= 0 ? index : all.length, 0, variable);
        }
        environ = array(all.map(variable=>variable.narrow));
        if (wide)
        {
            wenviron = array(all.map(variable=>variable.wide));
        }
        publish();
        host.setVariable?.(name, value === '' ? null : value);
    };

    /**
     * `_putenv`'s argument: NAME=value, the name not empty.
     *
     * @param {string} text
     * @returns {[string, string] | null}
     */
    const parse = text=>{
        const equals = text.indexOf('=');
        return equals <= 0 ? null : [text.slice(0, equals), text.slice(equals + 1)];
    };

    /** @param {number} pointer */
    const readNarrow = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} pointer */
    const readWide = pointer=>wideStringAt(host.readMemory, pointer);

    /** Where a variable's value starts in its narrow string. @param {Variable} variable */
    const narrowValue = variable=>variable.narrow + encodeAnsi(variable.name).length + 1;

    /**
     * getenv_s's body, for either width: the length with the terminator
     * through `length`, the value into a buffer that holds it, ERANGE for
     * one that does not; no name, or none set, is a length of none.
     *
     * @param {number} length @param {number} buffer @param {number} size
     * @param {string | null} name @param {number} unit
     */
    const getenvInto = (length, buffer, size, name, unit)=>{
        if ((length >>> 0) === 0 || ((buffer >>> 0) === 0 && (size >>> 0) !== 0))
        {
            host.errno(EINVAL);
            return EINVAL;
        }
        const index = name === null ? -1 : find(name);
        if ((buffer >>> 0) !== 0 && (size >>> 0) !== 0)
        {
            host.writeMemory(buffer, new Uint8Array(unit));
        }
        if (index < 0)
        {
            writeU32(length, 0);
            return 0;
        }
        const value = start()[index].value;
        const bytes = unit === 1 ? encodeAnsi(`${value}\0`) : wideBytes(value);
        writeU32(length, bytes.length / unit);
        if (bytes.length / unit > (size >>> 0))
        {
            host.errno(ERANGE);
            return ERANGE;
        }
        host.writeMemory(buffer, bytes);
        return 0;
    };

    /** @param {string} text */
    const wideBytes = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        return bytes;
    };

    /**
     * _putenv_s's body: a name and a value, neither absent, the name with no
     * '=' in it; an empty value removes.
     *
     * @param {string | null} name @param {string | null} value @param {boolean} wide
     */
    const putenvPair = (name, value, wide)=>{
        if (name === null || value === null || name === '' || name.includes('='))
        {
            host.errno(EINVAL);
            return EINVAL;
        }
        set(name, value, wide);
        return 0;
    };

    /**
     * The accessor of a variable: its export's own address, or a cell holding
     * the same.
     *
     * @param {string} name
     */
    const accessor = name=>({
        convention: 'cdecl',
        argBytes: 0,
        handler: ()=>{
            start();
            publish();
            return (host.addressOf?.(name) ?? 0) || host.cell(name);
        },
    });

    /** @param {number} value */
    const dword = value=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    };

    const functions = {
        /**
         * char *getenv(const char *name)
         *
         * A pointer into the variable's own string in `_environ`, found
         * without regard to case; null for none, and for no name.
         */
        getenv: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                const index = find(readNarrow(name));
                return index < 0 ? 0 : narrowValue(start()[index]);
            },
        },

        /** wchar_t *_wgetenv(const wchar_t *name) */
        _wgetenv: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                const all = startWide();
                const index = find(readWide(name), true);
                return index < 0 ? 0 : all[index].wide + (all[index].name.length + 1) * 2;
            },
        },

        /**
         * int _putenv(const char *text)
         *
         * "NAME=value" sets, "NAME=" removes -- an absent variable too; no
         * '=', or no name before it, is -1.
         */
        _putenv: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                const pair = (text >>> 0) === 0 ? null : parse(readNarrow(text));
                if (!pair)
                {
                    host.errno(EINVAL);
                    return -1;
                }
                set(pair[0], pair[1]);
                return 0;
            },
        },

        /** int _wputenv(const wchar_t *text) */
        _wputenv: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                startWide();
                const pair = (text >>> 0) === 0 ? null : parse(readWide(text));
                if (!pair)
                {
                    host.errno(EINVAL);
                    return -1;
                }
                set(pair[0], pair[1], true);
                return 0;
            },
        },

        /** errno_t _putenv_s(const char *name, const char *value) */
        _putenv_s: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, value])=>putenvPair((name >>> 0) === 0 ? null : readNarrow(name),
                (value >>> 0) === 0 ? null : readNarrow(value), false),
        },

        /** errno_t _wputenv_s(const wchar_t *name, const wchar_t *value) */
        _wputenv_s: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, value])=>{
                startWide();
                return putenvPair((name >>> 0) === 0 ? null : readWide(name),
                    (value >>> 0) === 0 ? null : readWide(value), true);
            },
        },

        /** errno_t getenv_s(size_t *length, char *buffer, size_t size, const char *name) */
        getenv_s: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([length, buffer, size, name])=>getenvInto(length, buffer, size,
                (name >>> 0) === 0 ? null : readNarrow(name), 1),
        },

        /** errno_t _wgetenv_s(size_t *length, wchar_t *buffer, size_t size, const wchar_t *name) */
        _wgetenv_s: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([length, buffer, size, name])=>getenvInto(length, buffer, size,
                (name >>> 0) === 0 ? null : readWide(name), 2),
        },

        /**
         * errno_t _dupenv_s(char **buffer, size_t *length, const char *name)
         *
         * The value on the heap, for the caller to free; null and a length of
         * none for a variable not set.
         */
        _dupenv_s: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, length, name])=>{
                if ((buffer >>> 0) === 0 || (name >>> 0) === 0)
                {
                    host.errno(EINVAL);
                    return EINVAL;
                }
                const index = find(readNarrow(name));
                const bytes = index < 0 ? null : encodeAnsi(`${start()[index].value}\0`);
                const copy = bytes ? place(bytes) : 0;
                writeU32(buffer, copy);
                if ((length >>> 0) !== 0)
                {
                    writeU32(length, copy === 0 ? 0 : /** @type {Uint8Array} */ (bytes).length);
                }
                return 0;
            },
        },

        /** char ***__p__environ(void) */
        __p__environ: accessor('_environ'),
        /** wchar_t ***__p__wenviron(void) */
        __p__wenviron: accessor('_wenviron'),
        /** char ***__p___initenv(void) */
        __p___initenv: accessor('__initenv'),
        /** wchar_t ***__p___winitenv(void) */
        __p___winitenv: accessor('__winitenv'),

        /** void _get_environ(char ***environ) */
        _get_environ: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                start();
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, environ);
                }
                return 0;
            },
        },

        /** void _get_wenviron(wchar_t ***environ): null before the wide copy exists. */
        _get_wenviron: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, wenviron);
                }
                return 0;
            },
        },

        /**
         * char **_environ, wchar_t **_wenviron, char **__initenv,
         * wchar_t **__winitenv
         *
         * Variables: the arrays, as placed at start -- the wide ones null.
         */
        _environ: { data: ()=>dword((start(), environ)) },
        _wenviron: { data: ()=>dword(wenviron) },
        __initenv: { data: ()=>dword((start(), initenv)) },
        __winitenv: { data: ()=>dword(winitenv) },
    };

    return {
        functions,
        /** The narrow array, `__getmainargs`'s third answer. */
        narrow: ()=>{
            start();
            return environ;
        },
        /** The wide array, made now if it was not yet: `__wgetmainargs`'s. */
        wide: ()=>{
            startWide();
            return wenviron;
        },
        /**
         * A variable's value as the runtime holds it, for its own readers
         * (`_tzset`'s TZ, `_searchenv`'s path); null for none.
         *
         * @param {string} name
         */
        value: name=>{
            const index = find(name);
            return index < 0 ? null : start()[index].value;
        },
        /** @param {string} name @param {string} value  For the runtime's own writers. */
        set: (name, value)=>set(name, value),
    };
}

