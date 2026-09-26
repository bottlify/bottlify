/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The private-profile family: `.ini` files read and written a key at a time.
 *
 * An installer keeps its state this way -- which files it unpacked, where its
 * engine is, what to delete when it is done -- and the protocol between the
 * process that writes such a file and the one that reads it back is the whole
 * of what these calls have to get right. The file is text on the volume, so
 * nothing is cached: a program that writes a key and then starts another
 * program to read it must find it there.
 *
 * The answers that are not obvious from the signatures, and are what a caller
 * switches on:
 *
 * - A section name of NULL lists the sections, and a key name of NULL lists a
 *   section's keys -- each name NUL-terminated and the list ended by a second
 *   NUL. A buffer too small for a list is cut two short and the count is the
 *   size less two; too small for a value, one short and the size less one.
 * - A value is stripped of the blanks around it, and of one pair of quotes --
 *   single or double -- enclosing it. Trailing blanks of the default come off
 *   the same way.
 * - Writing with a NULL key removes the section; writing a NULL string
 *   removes the key. The file is created for a write and never for a read.
 * - A name with no directory in it lives in the Windows directory. That is
 *   where the system's own profile files are, and where an installer that
 *   names its file bare expects to find it again.
 */

/** Where a profile file with no directory of its own is. */
const WINDOWS_DIRECTORY = 'C:\\WINDOWS';

/** A section or key name longer than this is a pointer that is not one. */
const MAX_NAME = 0x1000;
/** And a value or file name, likewise. */
const MAX_VALUE = 0x10000;

/**
 * @typedef {Object} ProfileHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {import('./files.js').FileSystem} files
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           What a structure is written from. Without it a structure cannot
 *           be written, and the write says so.
 * @property {(code: number) => void} [setLastError]
 */

/** Why a structure was not read back. */
const ERROR_INVALID_DATA = 13;
const ERROR_BAD_LENGTH = 24;
const ERROR_INVALID_FUNCTION = 1;

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

/** @param {Uint8Array} bytes */
const fromLatin1 = bytes=>{
    let text = '';
    for (const byte of bytes)
    {
        text += String.fromCharCode(byte);
    }
    return text;
};

/** @param {string} left @param {string} right */
const sameName = (left, right)=>left.toLowerCase() === right.toLowerCase();

/**
 * A profile file as lines, and where its sections and keys are among them.
 *
 * Kept as lines rather than as a map so that a write puts one line back and
 * leaves the rest -- comments, blank lines, the order -- as the program that
 * made the file wrote them.
 *
 * @typedef {Object} ProfileLine
 * @property {string} text
 * @property {string | null} section  The section this line opens, or null.
 * @property {string | null} key      The key this line sets, or null.
 * @property {string} value           The value, already stripped.
 */

/** @param {string} raw @returns {string} the value a program reads */
const stripValue = raw=>{
    const trimmed = raw.trim();
    const first = trimmed[0];
    if (trimmed.length >= 2 && (first === '"' || first === '\'') && trimmed.endsWith(first))
    {
        return trimmed.slice(1, -1);
    }
    return trimmed;
};

/** @param {string} text @returns {ProfileLine} */
const parseLine = text=>{
    const trimmed = text.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    {
        return { text, section: trimmed.slice(1, -1).trim(), key: null, value: '' };
    }
    const equals = trimmed.indexOf('=');
    if (trimmed.startsWith(';') || equals < 0)
    {
        return { text, section: null, key: null, value: '' };
    }
    return {
        text,
        section: null,
        key: trimmed.slice(0, equals).trim(),
        value: stripValue(trimmed.slice(equals + 1)),
    };
};

/**
 * @param {ProfileHost} host
 */
export function createProfileFunctions(host){
    const { files } = host;

    /** @param {number} pointer @param {number} limit @returns {string | null} */
    const text = (pointer, limit)=>((pointer >>> 0) === 0
        ? null
        : host.readCString(pointer >>> 0, limit));

    /**
     * Where the file named is. A bare name is in the Windows directory, a
     * relative one under the current directory, and an absolute one where it
     * says.
     *
     * @param {string} name
     */
    const resolve = name=>{
        const written = name.replace(/\//g, '\\');
        if (/^[A-Za-z]:\\/.test(written) || written.startsWith('\\\\'))
        {
            return written;
        }
        if (!written.includes('\\'))
        {
            return `${WINDOWS_DIRECTORY}\\${written}`;
        }
        const current = files.currentDirectory();
        return written.startsWith('\\')
            ? current.slice(0, 2) + written
            : `${current.endsWith('\\') ? current : current + '\\'}${written}`;
    };

    /**
     * The file's lines, or none when it is not there. A file whose bytes are
     * not resident is answered late, which the bridge turns into a wait.
     *
     * @param {string} path
     * @returns {ProfileLine[] | Promise<ProfileLine[]>}
     */
    const load = path=>{
        const entry = files.stat(path);
        if (!entry || !entry.exists || entry.isDirectory)
        {
            return [];
        }
        const node = files.open(path, { read: true });
        if (!node)
        {
            return [];
        }
        /** @param {Uint8Array} bytes */
        const parse = bytes=>{
            files.close(node);
            const whole = fromLatin1(bytes);
            const lines = whole.split(/\r?\n/);
            // A trailing newline is the end of the last line, not an empty one.
            if (lines.length > 0 && lines[lines.length - 1] === '')
            {
                lines.pop();
            }
            return lines.map(parseLine);
        };
        const read = files.read(node, 0, entry.size);
        return read instanceof Promise ? read.then(parse) : parse(read);
    };

    /** @param {string} path @param {ProfileLine[]} lines */
    const store = (path, lines)=>{
        const node = files.open(path, { write: true, create: true, truncate: true });
        if (!node)
        {
            return false;
        }
        const body = lines.map(line=>`${line.text}\r\n`).join('');
        files.write(node, 0, latin1(body));
        files.close(node);
        return true;
    };

    /**
     * The index of the line opening a section, and of the line past its end.
     *
     * @param {ProfileLine[]} lines @param {string} section
     * @returns {{ start: number, end: number } | null}
     */
    const sectionSpan = (lines, section)=>{
        const start = lines.findIndex(
            line=>line.section !== null && sameName(line.section, section));
        if (start < 0)
        {
            return null;
        }
        let end = start + 1;
        while (end < lines.length && lines[end].section === null)
        {
            end++;
        }
        return { start, end };
    };

    /**
     * Writes a list of names, NUL-separated and NUL-ended, into a buffer that
     * may be too small for it.
     *
     * @param {number} buffer @param {number} size @param {string[]} names
     * @returns {number} what the call answers
     */
    const writeList = (buffer, size, names)=>{
        const room = size >>> 0;
        if (room === 0)
        {
            return 0;
        }
        const whole = names.map(name=>`${name}\0`).join('');
        if (whole.length + 1 <= room)
        {
            host.writeMemory(buffer >>> 0, latin1(`${whole}\0`));
            return whole.length;
        }
        // Cut two short: one NUL to end the name it cut, one to end the list.
        const kept = room >= 2 ? whole.slice(0, room - 2) : '';
        host.writeMemory(buffer >>> 0, latin1(`${kept}\0\0`.slice(0, room)));
        return Math.max(room - 2, 0);
    };

    /**
     * @param {number} buffer @param {number} size @param {string} value
     * @returns {number} what the call answers
     */
    const writeValue = (buffer, size, value)=>{
        const room = size >>> 0;
        if (room === 0)
        {
            return 0;
        }
        const kept = value.slice(0, room - 1);
        host.writeMemory(buffer >>> 0, latin1(`${kept}\0`));
        return kept.length;
    };

    /**
     * What GetPrivateProfileString finds, before it is written anywhere.
     *
     * @param {ProfileLine[]} lines
     * @param {string | null} section @param {string | null} key
     * @param {string} fallback
     * @returns {{ names: string[] } | { value: string }}
     */
    const lookUp = (lines, section, key, fallback)=>{
        if (section === null)
        {
            return { names: lines.flatMap(line=>(line.section === null ? [] : [line.section])) };
        }
        const span = sectionSpan(lines, section);
        if (key === null)
        {
            return { names: span === null
                ? []
                : lines.slice(span.start + 1, span.end)
                    .flatMap(line=>(line.key === null ? [] : [line.key])) };
        }
        const found = span === null
            ? undefined
            : lines.slice(span.start + 1, span.end)
                .find(line=>line.key !== null && sameName(line.key, key));
        return { value: found ? found.value : fallback };
    };

    /**
     * @param {number} buffer @param {number} size
     * @param {{ names: string[] } | { value: string }} answer
     */
    const deliver = (buffer, size, answer)=>('names' in answer
        ? writeList(buffer, size, answer.names)
        : writeValue(buffer, size, answer.value));

    /**
     * The integer at the front of a value, the way the C runtime reads one:
     * blanks, a sign, digits, and nothing after the digits matters. No digits
     * is zero, whatever the default was, because the key was there.
     *
     * @param {string} value
     */
    const integerOf = value=>{
        const match = /^\s*([+-]?)(\d+)/.exec(value);
        if (!match)
        {
            return 0;
        }
        const magnitude = Number(match[2]) % 0x100000000;
        return (match[1] === '-' ? -magnitude : magnitude) >>> 0;
    };

    /**
     * The lines after a write, or null when the write changes nothing.
     *
     * @param {ProfileLine[]} lines
     * @param {string} section @param {string | null} key @param {string | null} value
     * @returns {ProfileLine[] | null}
     */
    const edit = (lines, section, key, value)=>{
        const span = sectionSpan(lines, section);
        if (key === null)
        {
            return span === null ? null : [...lines.slice(0, span.start), ...lines.slice(span.end)];
        }
        if (span === null)
        {
            if (value === null)
            {
                return null;
            }
            return [...lines, parseLine(`[${section}]`), parseLine(`${key}=${value}`)];
        }
        const at = lines.findIndex((line, index)=>index > span.start && index < span.end
            && line.key !== null && sameName(line.key, key));
        if (value === null)
        {
            return at < 0 ? null : [...lines.slice(0, at), ...lines.slice(at + 1)];
        }
        const line = parseLine(`${key}=${value}`);
        return at < 0
            ? [...lines.slice(0, span.end), line, ...lines.slice(span.end)]
            : [...lines.slice(0, at), line, ...lines.slice(at + 1)];
    };

    /**
     * The three questions, each asked of a private profile by path and of
     * win.ini with its path fixed: the same body, so the two cannot differ.
     */

    /**
     * @param {string | null} path @param {number} section @param {number} key
     * @param {number} fallback @param {number} buffer @param {number} size
     */
    const getString = (path, section, key, fallback, buffer, size)=>{
        const wanted = {
            section: text(section, MAX_NAME),
            key: text(key, MAX_NAME),
            fallback: (text(fallback, MAX_VALUE) ?? '').replace(/\s+$/, ''),
        };
        /** @param {ProfileLine[]} lines */
        const answer = lines=>deliver(buffer, size,
            lookUp(lines, wanted.section, wanted.key, wanted.fallback));
        const loaded = path === null ? [] : load(path);
        return loaded instanceof Promise ? loaded.then(answer) : answer(loaded);
    };

    /**
     * @param {string | null} path @param {number} section @param {number} key
     * @param {number} fallback
     */
    const getInt = (path, section, key, fallback)=>{
        const wanted = { section: text(section, MAX_NAME), key: text(key, MAX_NAME) };
        /** @param {ProfileLine[]} lines */
        const answer = lines=>{
            // Neither name may be NULL here: there is no list to
            // read a number out of, and the default is the answer.
            if (wanted.section === null || wanted.key === null)
            {
                return fallback >>> 0;
            }
            const found = lookUp(lines, wanted.section, wanted.key, '');
            const value = 'value' in found ? found.value : '';
            return value === '' ? fallback >>> 0 : integerOf(value);
        };
        const loaded = path === null ? [] : load(path);
        return loaded instanceof Promise ? loaded.then(answer) : answer(loaded);
    };

    /**
     * @param {string | null} path @param {number} section @param {number} key
     * @param {number} value
     */
    const put = (path, section, key, value)=>putText(path, section, key, text(value, MAX_VALUE));

    /**
     * @param {string | null} path @param {number} section @param {number} key
     * @param {string | null} value
     */
    const putText = (path, section, key, value)=>{
        const wanted = {
            section: text(section, MAX_NAME),
            key: text(key, MAX_NAME),
            value,
        };
        if (path === null || wanted.section === null)
        {
            return 0;
        }
        /** @param {ProfileLine[]} lines */
        const answer = lines=>{
            const changed = edit(lines, /** @type {string} */ (wanted.section),
                wanted.key, wanted.value);
            return changed === null || store(path, changed) ? 1 : 0;
        };
        const loaded = load(path);
        return loaded instanceof Promise ? loaded.then(answer) : answer(loaded);
    };

    /**
     * A structure's bytes as its profile value: each byte in two hex digits,
     * then the low byte of their sum, which is what reading it back checks.
     *
     * @param {Uint8Array} bytes
     */
    const structText = bytes=>{
        const sum = bytes.reduce((total, byte)=>total + byte, 0) & 0xff;
        return [...bytes, sum]
            .map(byte=>byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    };

    /** @param {number} file @returns {string | null} */
    const pathOf = file=>{
        const name = text(file, MAX_VALUE);
        return name === null ? null : resolve(name);
    };

    const WIN_INI = `${WINDOWS_DIRECTORY}\\win.ini`;

    return {
        /**
         * DWORD GetPrivateProfileStringA(LPCSTR lpAppName, LPCSTR lpKeyName,
         *   LPCSTR lpDefault, LPSTR lpReturnedString, DWORD nSize, LPCSTR lpFileName)
         */
        GetPrivateProfileStringA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([section, key, fallback, buffer, size, file])=>
                getString(pathOf(file), section, key, fallback, buffer, size),
        },

        /**
         * UINT GetPrivateProfileIntA(LPCSTR lpAppName, LPCSTR lpKeyName,
         *   INT nDefault, LPCSTR lpFileName)
         */
        GetPrivateProfileIntA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([section, key, fallback, file])=>getInt(pathOf(file), section, key, fallback),
        },

        /**
         * DWORD GetPrivateProfileSectionA(LPCSTR lpAppName, LPSTR lpReturnedString,
         *   DWORD nSize, LPCSTR lpFileName)
         *
         * Every entry of the section as `key=value`, as it stands in the
         * file, in one NUL-separated list -- the shape a caller walks with
         * the same loop it walks the key list with.
         */
        GetPrivateProfileSectionA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([section, buffer, size, file])=>{
                const path = pathOf(file);
                const name = text(section, MAX_NAME);
                /** @param {ProfileLine[]} lines */
                const answer = lines=>{
                    const span = name === null ? null : sectionSpan(lines, name);
                    const entries = span === null
                        ? []
                        : lines.slice(span.start + 1, span.end)
                            .filter(line=>line.key !== null)
                            .map(line=>line.text.trim());
                    return writeList(buffer, size, entries);
                };
                const loaded = path === null ? [] : load(path);
                return loaded instanceof Promise ? loaded.then(answer) : answer(loaded);
            },
        },

        /**
         * DWORD GetPrivateProfileSectionNamesA(LPSTR lpszReturnBuffer,
         *   DWORD nSize, LPCSTR lpFileName)
         *
         * The list a NULL section name gives GetPrivateProfileString, under
         * its own name.
         */
        GetPrivateProfileSectionNamesA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, size, file])=>{
                const path = pathOf(file);
                /** @param {ProfileLine[]} lines */
                const answer = lines=>deliver(buffer, size, lookUp(lines, null, null, ''));
                const loaded = path === null ? [] : load(path);
                return loaded instanceof Promise ? loaded.then(answer) : answer(loaded);
            },
        },

        /**
         * BOOL WritePrivateProfileStringA(LPCSTR lpAppName, LPCSTR lpKeyName,
         *   LPCSTR lpString, LPCSTR lpFileName)
         */
        WritePrivateProfileStringA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([section, key, value, file])=>put(pathOf(file), section, key, value),
        },

        /**
         * BOOL GetPrivateProfileStructA(LPCSTR lpszSection, LPCSTR lpszKey,
         *   LPVOID lpStruct, UINT uSizeStruct, LPCSTR szFile)
         *
         * Only a value of exactly the size asked, with its checksum right,
         * is read back: anything else is a different structure or a damaged
         * one, and a caller given part of it would take it for the whole.
         */
        GetPrivateProfileStructA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([section, key, buffer, size, file])=>{
                const wanted = { section: text(section, MAX_NAME), key: text(key, MAX_NAME) };
                const path = pathOf(file);
                /** @param {ProfileLine[]} lines */
                const answer = lines=>{
                    const found = wanted.section === null || wanted.key === null
                        ? { value: '' }
                        : lookUp(lines, wanted.section, wanted.key, '');
                    const value = 'value' in found ? found.value : '';
                    const length = size >>> 0;
                    if (value.length !== (length + 1) * 2)
                    {
                        host.setLastError?.(ERROR_BAD_LENGTH);
                        return 0;
                    }
                    if (!/^[0-9a-f]*$/i.test(value))
                    {
                        host.setLastError?.(ERROR_INVALID_DATA);
                        return 0;
                    }
                    const bytes = Uint8Array.from({ length: length + 1 },
                        (_, at)=>parseInt(value.slice(at * 2, at * 2 + 2), 16));
                    const data = bytes.subarray(0, length);
                    if ((data.reduce((total, byte)=>total + byte, 0) & 0xff) !== bytes[length])
                    {
                        host.setLastError?.(ERROR_INVALID_DATA);
                        return 0;
                    }
                    host.writeMemory(buffer >>> 0, data);
                    return 1;
                };
                const loaded = path === null ? [] : load(path);
                return loaded instanceof Promise ? loaded.then(answer) : answer(loaded);
            },
        },

        /**
         * BOOL WritePrivateProfileStructA(LPCSTR lpszSection, LPCSTR lpszKey,
         *   LPVOID lpStruct, UINT uSizeStruct, LPCSTR szFile)
         *
         * A NULL structure removes the key, as a NULL string does.
         */
        WritePrivateProfileStructA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([section, key, structure, size, file])=>{
                if ((structure >>> 0) === 0)
                {
                    return put(pathOf(file), section, key, 0);
                }
                if (!host.readMemory)
                {
                    host.setLastError?.(ERROR_INVALID_FUNCTION);
                    return 0;
                }
                const value = structText(host.readMemory(structure >>> 0, size >>> 0));
                return putText(pathOf(file), section, key, value);
            },
        },

        /**
         * DWORD GetProfileStringA(LPCSTR lpAppName, LPCSTR lpKeyName,
         *   LPCSTR lpDefault, LPSTR lpReturnedString, DWORD nSize)
         * UINT GetProfileIntA(LPCSTR lpAppName, LPCSTR lpKeyName, INT nDefault)
         * BOOL WriteProfileStringA(LPCSTR lpAppName, LPCSTR lpKeyName, LPCSTR lpString)
         *
         * win.ini: a private profile whose name is fixed.
         */
        GetProfileStringA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([section, key, fallback, buffer, size])=>
                getString(WIN_INI, section, key, fallback, buffer, size),
        },
        GetProfileIntA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([section, key, fallback])=>getInt(WIN_INI, section, key, fallback),
        },
        WriteProfileStringA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([section, key, value])=>put(WIN_INI, section, key, value),
        },
    };
}
