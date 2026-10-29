/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The event log: the logs a service or an installer's helper reports to, and
 * reads back.
 *
 * The logs are the ones the registry names under
 * `HKLM\SYSTEM\CurrentControlSet\Services\Eventlog` -- Application, System and
 * Security on every machine, and any a program adds -- and a source is a key
 * under its log. Opening a name that is neither a log nor a source opens
 * Application, as the event log service does. The records are kept for the
 * session: the service started with it, and its first record in the System
 * log says so.
 *
 * A record is an EVENTLOGRECORD, laid out as Windows lays one out: the fixed
 * part, the source and computer names, the user's SID on a DWORD boundary,
 * the strings, the data, and the length again at its end; the A calls read
 * the same record with its texts in the ANSI page. A backup is a file of the
 * same records behind an ELF_LOGFILE_HEADER, which OpenBackupEventLog reads.
 *
 * Event tracing (StartTrace and the provider calls) keeps its sessions and
 * registrations by name and handle; nothing here consumes what is traced.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { HKEY_LOCAL_MACHINE } from './registry.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_BAD_LENGTH = 24;
const ERROR_HANDLE_EOF = 38;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_LEVEL = 124;
const ERROR_BAD_PATHNAME = 161;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_EVENTLOG_FILE_CORRUPT = 1500;
const RPC_S_SERVER_UNAVAILABLE = 1722;
const RPC_X_NULL_REF_POINTER = 1780;

/** ReadEventLog's flags: how to move, and which way. */
const EVENTLOG_SEQUENTIAL_READ = 0x1;
const EVENTLOG_SEEK_READ = 0x2;
const EVENTLOG_FORWARDS_READ = 0x4;
const EVENTLOG_BACKWARDS_READ = 0x8;
const EVENTLOG_INFORMATION_TYPE = 0x4;
/** GetEventLogInformation's one level, and the record it answers. */
const EVENTLOG_FULL_INFO = 0;

/** EVENTLOGRECORD's fixed part, and the signature in its second DWORD. */
const RECORD_HEADER = 56;
const RECORD_SIGNATURE = 0x654c664c;
/** ELF_LOGFILE_HEADER and the end-of-file record after the last event. */
const FILE_HEADER = 48;
const EOF_RECORD = 40;
/** The event the service writes to the System log as it starts. */
const EVENT_EVENTLOG_STARTED = 0x80001775;

/** EVENT_TRACE_PROPERTIES on a 32-bit machine. */
const TRACE_PROPERTIES = 120;
const TRACE = Object.freeze({ BUFFER_SIZE: 0, GUID: 24, LOG_FILE_MODE: 64,
    LOG_FILE_NAME: 108, LOGGER_NAME: 112 });
const EVENT_TRACE_FILE_MODE_SEQUENTIAL = 0x1;
const EVENT_TRACE_FILE_MODE_CIRCULAR = 0x2;
const EVENT_TRACE_REAL_TIME_MODE = 0x100;
const EVENT_TRACE_CONTROL_STOP = 1;
/** The kernel logger's GUID and the one name a session of it may have. */
const SYSTEM_TRACE_CONTROL_GUID = '9e814aad320411d29a82006008a86939';
const KERNEL_LOGGER_NAME = 'NT KERNEL LOGGER';

/** Where the logs and their sources are kept. */
const EVENTLOG_PATH = 'SYSTEM\\CurrentControlSet\\Services\\Eventlog';
/** The logs every machine has. */
const STANDARD_LOGS = ['Application', 'System', 'Security'];

/** The longest log, source or file name read out of the guest. */
const MAX_NAME = 0x8000;

/** @typedef {(address: number, maxLength: number) => string} Reader */

/**
 * @typedef {Object} EventRecord
 * @property {number} number
 * @property {number} time       Seconds since 1970, generated and written alike.
 * @property {number} id
 * @property {number} type
 * @property {number} category
 * @property {string} source
 * @property {string} computer
 * @property {Uint8Array | null} sid
 * @property {string[]} strings
 * @property {Uint8Array} data
 */

/**
 * @typedef {Object} EventLogHost
 * @property {Reader} readCString
 * @property {Reader} readWideString
 * @property {(code: number) => void} setLastError
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {ReturnType<typeof import('./registry-service.js').createRegistryService>} [hive]
 *           Where the logs and their sources are named. Without it there
 *           are the standard three, and every source writes to Application.
 * @property {import('../ole32/storage.js').StorageFiles} [files]
 *           Where a backup is written and read. Without it a backup is refused.
 * @property {() => number} [now]  The wall clock, in seconds since 1970.
 * @property {string} [computerName]
 */

/** @param {string} text @param {boolean} wide @returns {Uint8Array} with its terminator */
const textBytes = (text, wide)=>(wide
    ? new Uint8Array(Uint16Array.from(`${text}\0`, c=>c.charCodeAt(0)).buffer)
    : encodeAnsi(`${text}\0`));

/** @param {number} value */
const align4 = value=>value + 3 & ~3;

/**
 * A record laid out, its texts in UTF-16 or the ANSI page.
 *
 * @param {EventRecord} record @param {boolean} wide
 */
export const recordBytes = (record, wide)=>{
    const source = textBytes(record.source, wide);
    const computer = textBytes(record.computer, wide);
    // The SID, or the strings where there is none, start on an eight-byte boundary.
    const sidAt = RECORD_HEADER + source.length + computer.length + 7 & ~7;
    const sidLength = record.sid?.length ?? 0;
    const strings = record.strings.map(text=>textBytes(text, wide));
    const stringAt = sidAt + sidLength;
    const dataAt = stringAt + strings.reduce((sum, bytes)=>sum + bytes.length, 0);
    const length = align4(dataAt + record.data.length) + 4;
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, length, true);
    view.setUint32(4, RECORD_SIGNATURE, true);
    view.setUint32(8, record.number, true);
    view.setUint32(12, record.time, true);
    view.setUint32(16, record.time, true);
    view.setUint32(20, record.id, true);
    view.setUint16(24, record.type, true);
    view.setUint16(26, record.strings.length, true);
    view.setUint16(28, record.category, true);
    view.setUint32(36, stringAt, true);
    view.setUint32(40, sidLength, true);
    view.setUint32(44, sidAt, true);
    view.setUint32(48, record.data.length, true);
    view.setUint32(52, dataAt, true);
    bytes.set(source, RECORD_HEADER);
    bytes.set(computer, RECORD_HEADER + source.length);
    if (record.sid)
    {
        bytes.set(record.sid, sidAt);
    }
    let at = stringAt;
    for (const text of strings)
    {
        bytes.set(text, at);
        at += text.length;
    }
    bytes.set(record.data, dataAt);
    view.setUint32(length - 4, length, true);
    return bytes;
};

/**
 * A wide record read back: what a backup file holds.
 *
 * @param {Uint8Array} bytes @returns {EventRecord | null}
 */
const parseRecord = bytes=>{
    if (bytes.length < RECORD_HEADER + 4)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (view.getUint32(4, true) !== RECORD_SIGNATURE)
    {
        return null;
    }
    /** @param {number} at @returns {[string, number]} the text and where it ends */
    const wideText = at=>{
        let text = '';
        while (at + 1 < bytes.length)
        {
            const code = view.getUint16(at, true);
            at += 2;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return [text, at];
    };
    const [source, afterSource] = wideText(RECORD_HEADER);
    const [computer] = wideText(afterSource);
    const strings = [];
    let at = view.getUint32(36, true);
    for (let index = 0; index < view.getUint16(26, true); index++)
    {
        const [text, end] = wideText(at);
        strings.push(text);
        at = end;
    }
    const sidLength = view.getUint32(40, true);
    const sidAt = view.getUint32(44, true);
    const dataAt = view.getUint32(52, true);
    return {
        number: view.getUint32(8, true), time: view.getUint32(12, true),
        id: view.getUint32(20, true), type: view.getUint16(24, true),
        category: view.getUint16(28, true), source, computer,
        sid: sidLength === 0 ? null : bytes.slice(sidAt, sidAt + sidLength),
        strings, data: bytes.slice(dataAt, dataAt + view.getUint32(48, true)),
    };
};

/**
 * @param {EventLogHost} host
 */
export function createEventLogFunctions(host){
    /** @type {Map<string, { name: string, records: EventRecord[], next: number }>} */
    const logs = new Map();
    const computer = host.computerName ?? 'COMPUTER';
    const now = ()=>host.now?.() ?? Math.floor(Date.now() / 1000);

    /** @param {string} name */
    const logNamed = name=>{
        const key = name.toUpperCase();
        let log = logs.get(key);
        if (!log)
        {
            log = { name, records: [], next: 1 };
            logs.set(key, log);
            if (key === 'SYSTEM')
            {
                // The service's own first record: it started with the session.
                append(log, { id: EVENT_EVENTLOG_STARTED, type: EVENTLOG_INFORMATION_TYPE,
                    category: 0, source: 'EventLog', sid: null, strings: [],
                    data: new Uint8Array(24) });
            }
        }
        return log;
    };

    /**
     * @param {{ records: EventRecord[], next: number }} log
     * @param {Omit<EventRecord, 'number' | 'time' | 'computer'>} event
     */
    const append = (log, event)=>{
        log.records.push({ ...event, number: log.next++, time: now(), computer });
    };

    /** The logs the registry names, and the standard three. */
    const logNames = ()=>{
        const root = host.hive?.root(HKEY_LOCAL_MACHINE);
        const key = root ? host.hive?.open(root, EVENTLOG_PATH) : null;
        const named = key ? /** @type {string[]} */ (host.hive?.subkeys(key) ?? []) : [];
        return [...STANDARD_LOGS, ...named.filter(name=>!STANDARD_LOGS
            .some(standard=>standard.toUpperCase() === name.toUpperCase()))];
    };

    /**
     * The log a name opens: a log by its name, the log a source is under, or
     * Application.
     *
     * @param {string} name
     */
    const logFor = name=>{
        const names = logNames();
        const log = names.find(entry=>entry.toUpperCase() === name.toUpperCase());
        if (log)
        {
            return logNamed(log);
        }
        const root = host.hive?.root(HKEY_LOCAL_MACHINE);
        const base = root ? host.hive?.open(root, EVENTLOG_PATH) : null;
        const owner = base ? names.find(entry=>{
            const key = host.hive?.open(base, entry);
            return key ? host.hive?.open(key, name) !== null : false;
        }) : undefined;
        return logNamed(owner ?? 'Application');
    };

    /** @param {number} handle @param {string} [kind] @returns {any} */
    const handleOf = (handle, kind)=>{
        try
        {
            const object = host.handles.resolve(handle >>> 0, 'eventlog');
            return object && (kind === undefined || object.kind === kind) ? object : null;
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory?.(address >>> 0, 4);
        return bytes ? (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0 : 0;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory?.(address >>> 0, bytes);
    };

    /** @param {boolean} wide @returns {Reader} */
    const readerOf = wide=>(wide ? (address, length)=>host.readWideString(address, length * 2)
        : host.readCString);

    /** @param {string | null} server */
    const isLocal = server=>server === null || server === ''
        || server.replace(/^\\\\/, '').toUpperCase() === computer.toUpperCase();

    /** @param {boolean} wide @param {boolean} register */
    const open = (wide, register)=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([serverName, sourceName])=>{
            const read = readerOf(wide);
            if ((sourceName >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (!isLocal((serverName >>> 0) === 0 ? null : read(serverName >>> 0, MAX_NAME)))
            {
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            const source = read(sourceName >>> 0, MAX_NAME);
            const log = logFor(source);
            return host.handles.open('eventlog', { kind: 'log', log, source, cursor: null,
                register });
        },
    });

    /** @param {boolean} wide */
    const report = wide=>({
        argBytes: 36,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, type, category, id, sid, count, dataSize,
            strings, data])=>{
            const object = handleOf(handle, 'log');
            if (!object)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const read = readerOf(wide);
            const texts = [];
            for (let at = 0; at < (count & 0xffff); at++)
            {
                const pointer = readDword((strings >>> 0) + at * 4);
                texts.push(pointer === 0 ? '' : read(pointer, MAX_NAME));
            }
            const sidBytes = (sid >>> 0) === 0 || !host.readMemory ? null
                : host.readMemory(sid >>> 0, 8 + 4 * host.readMemory(sid >>> 0, 2)[1]).slice();
            append(object.log, {
                id: id >>> 0, type: type & 0xffff, category: category & 0xffff,
                source: object.source, sid: sidBytes, strings: texts,
                data: (data >>> 0) === 0 || (dataSize >>> 0) === 0 || !host.readMemory
                    ? new Uint8Array(0) : host.readMemory(data >>> 0, dataSize >>> 0).slice(),
            });
            return 1;
        },
    });

    /** @param {number} handle @returns {EventRecord[] | null} the records a handle reads */
    const recordsOf = handle=>{
        const object = handleOf(handle);
        return object ? (object.kind === 'log' ? object.log.records : object.records) : null;
    };

    /**
     * ReadEventLog: from where the handle left off, or the record a seek
     * names, as many whole records as fit; none fitting asks for the size of
     * the first, and reading past the last is the end of the file.
     *
     * @param {boolean} wide
     */
    const readLog = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, flags, offset, buffer, size, read, needed])=>{
            const how = flags & (EVENTLOG_SEQUENTIAL_READ | EVENTLOG_SEEK_READ);
            const way = flags & (EVENTLOG_FORWARDS_READ | EVENTLOG_BACKWARDS_READ);
            if ((read >>> 0) === 0 || (needed >>> 0) === 0
                || (how !== EVENTLOG_SEQUENTIAL_READ && how !== EVENTLOG_SEEK_READ)
                || (way !== EVENTLOG_FORWARDS_READ && way !== EVENTLOG_BACKWARDS_READ)
                || (buffer >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const object = handleOf(handle);
            const records = recordsOf(handle);
            if (!object || !records)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const forwards = way === EVENTLOG_FORWARDS_READ;
            let index;
            if (how === EVENTLOG_SEEK_READ)
            {
                index = records.findIndex(record=>record.number === (offset >>> 0));
                if (index < 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
            }
            else
            {
                const last = object.cursor;
                index = last === null ? (forwards ? 0 : records.length - 1)
                    : records.findIndex(record=>record.number === last) + (forwards ? 1 : -1);
            }
            if (index < 0 || index >= records.length)
            {
                writeDword(read, 0);
                writeDword(needed, 0);
                return fail(ERROR_HANDLE_EOF);
            }
            const out = [];
            let used = 0;
            for (let at = index; at >= 0 && at < records.length; at += forwards ? 1 : -1)
            {
                const bytes = recordBytes(records[at], wide);
                if (used + bytes.length > (size >>> 0))
                {
                    if (out.length === 0)
                    {
                        writeDword(read, 0);
                        writeDword(needed, bytes.length);
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    break;
                }
                out.push(bytes);
                used += bytes.length;
                object.cursor = records[at].number;
            }
            let at = buffer >>> 0;
            for (const bytes of out)
            {
                host.writeMemory?.(at, bytes);
                at += bytes.length;
            }
            writeDword(read, used);
            writeDword(needed, 0);
            return 1;
        },
    });

    /**
     * A log's records in a file: the header, the records as wide ones, and
     * the end-of-file record.
     *
     * @param {EventRecord[]} records @returns {Uint8Array}
     */
    const fileBytes = records=>{
        const bodies = records.map(record=>recordBytes(record, true));
        const end = FILE_HEADER + bodies.reduce((sum, bytes)=>sum + bytes.length, 0);
        const bytes = new Uint8Array(end + EOF_RECORD);
        const view = new DataView(bytes.buffer);
        const oldest = records[0]?.number ?? 1;
        const current = (records.at(-1)?.number ?? 0) + 1;
        [FILE_HEADER, RECORD_SIGNATURE, 1, 1, FILE_HEADER, end, current, oldest, 0x80000, 0, 0,
            FILE_HEADER].forEach((value, at)=>view.setUint32(at * 4, value, true));
        let at = FILE_HEADER;
        for (const body of bodies)
        {
            bytes.set(body, at);
            at += body.length;
        }
        [EOF_RECORD, 0x11111111, 0x22222222, 0x33333333, 0x44444444, FILE_HEADER, end, current,
            oldest, EOF_RECORD].forEach((value, index)=>
            view.setUint32(end + index * 4, value, true));
        return bytes;
    };

    /**
     * A backup file's records, or why it is not one.
     *
     * @param {Uint8Array} bytes @returns {EventRecord[] | number}
     */
    const parseFile = bytes=>{
        if (bytes.length < FILE_HEADER)
        {
            return bytes.length === 0 ? ERROR_NOT_ENOUGH_MEMORY : ERROR_EVENTLOG_FILE_CORRUPT;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        if (view.getUint32(0, true) !== FILE_HEADER || view.getUint32(4, true) !== RECORD_SIGNATURE)
        {
            return ERROR_EVENTLOG_FILE_CORRUPT;
        }
        const records = [];
        const end = Math.min(view.getUint32(20, true), bytes.length);
        for (let at = view.getUint32(16, true); at + 8 <= end;)
        {
            const length = view.getUint32(at, true);
            const record = length >= RECORD_HEADER && at + length <= end
                ? parseRecord(bytes.subarray(at, at + length)) : null;
            if (!record)
            {
                return ERROR_EVENTLOG_FILE_CORRUPT;
            }
            records.push(record);
            at += length;
        }
        return records;
    };

    /**
     * Writes a backup: refused where a file is already, or when there is no
     * volume to write to.
     *
     * @param {EventRecord[]} records @param {string} path @returns {number} an error
     */
    const backup = (records, path)=>{
        const files = host.files;
        if (!files)
        {
            return ERROR_ACCESS_DENIED;
        }
        if (files.stat(path)?.exists)
        {
            return ERROR_ALREADY_EXISTS;
        }
        const node = files.open(path, { write: true, create: true, truncate: true });
        if (!node)
        {
            return ERROR_ACCESS_DENIED;
        }
        files.write(node, 0, fileBytes(records));
        files.close(node);
        return ERROR_SUCCESS;
    };

    /** @param {boolean} wide */
    const backupLog = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([handle, fileName])=>{
            if ((fileName >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const records = recordsOf(handle);
            if (!records)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const error = backup(records, readerOf(wide)(fileName >>> 0, MAX_NAME));
            return error === ERROR_SUCCESS ? 1 : fail(error);
        },
    });

    /** @param {boolean} wide */
    const openBackup = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([serverName, fileName])=>{
            const read = readerOf(wide);
            if ((fileName >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (!isLocal((serverName >>> 0) === 0 ? null : read(serverName >>> 0, MAX_NAME)))
            {
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            const path = read(fileName >>> 0, MAX_NAME);
            const found = host.files?.stat(path);
            if (!host.files || !found?.exists || found.isDirectory)
            {
                return fail(ERROR_FILE_NOT_FOUND);
            }
            const files = host.files;
            const node = files.open(path, { read: true });
            if (!node)
            {
                return fail(ERROR_ACCESS_DENIED);
            }
            /** @param {Uint8Array} bytes */
            const opened = bytes=>{
                files.close(node);
                const records = parseFile(bytes);
                return typeof records === 'number' ? fail(records)
                    : host.handles.open('eventlog', { kind: 'backup', records, cursor: null });
            };
            const bytes = files.read(node, 0, found.size);
            return bytes instanceof Promise ? bytes.then(opened) : opened(bytes);
        },
    });

    /** @param {boolean} wide */
    const clearLog = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([handle, fileName])=>{
            const object = handleOf(handle, 'log');
            if (!object)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((fileName >>> 0) !== 0)
            {
                const error = backup(object.log.records, readerOf(wide)(fileName >>> 0, MAX_NAME));
                if (error !== ERROR_SUCCESS)
                {
                    return fail(error);
                }
            }
            object.log.records = [];
            object.log.next = 1;
            object.cursor = null;
            return 1;
        },
    });

    /** @param {number} handle */
    const close = handle=>{
        if (!handleOf(handle))
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        host.handles.close(handle >>> 0);
        return 1;
    };

    /** The trace sessions started, by name folded. */
    const sessions = new Map();
    let nextSession = 1;
    /** The providers registered, by their handle's low half. */
    const providers = new Set();
    let nextProvider = 1;

    /** @param {boolean} wide */
    const startTrace = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([out, nameAddress, properties])=>{
            if ((out >>> 0) === 0 || (properties >>> 0) === 0 || (nameAddress >>> 0) === 0
                || !host.readMemory)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const size = readDword(properties);
            if (size < TRACE_PROPERTIES)
            {
                return ERROR_BAD_LENGTH;
            }
            const name = readerOf(wide)(nameAddress >>> 0, MAX_NAME);
            const nameAt = readDword(properties + TRACE.LOGGER_NAME);
            const fileAt = readDword(properties + TRACE.LOG_FILE_NAME);
            if (nameAt + (name.length + 1) * (wide ? 2 : 1) > size)
            {
                return ERROR_BAD_LENGTH;
            }
            const mode = readDword(properties + TRACE.LOG_FILE_MODE);
            if (nameAt < TRACE_PROPERTIES || (fileAt !== 0 && fileAt < TRACE_PROPERTIES)
                || (mode & EVENT_TRACE_FILE_MODE_SEQUENTIAL) !== 0
                    && (mode & EVENT_TRACE_FILE_MODE_CIRCULAR) !== 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const guid = [...host.readMemory(properties + TRACE.GUID, 16)]
                .map(byte=>byte.toString(16).padStart(2, '0'));
            const guidText = [...guid.slice(0, 4).reverse(), ...guid.slice(4, 6).reverse(),
                ...guid.slice(6, 8).reverse(), ...guid.slice(8)].join('');
            if (guidText === SYSTEM_TRACE_CONTROL_GUID && name.toUpperCase() !== KERNEL_LOGGER_NAME)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (fileAt === 0 && (mode & EVENT_TRACE_REAL_TIME_MODE) === 0)
            {
                return ERROR_BAD_PATHNAME;
            }
            if (sessions.has(name.toUpperCase()))
            {
                return ERROR_ALREADY_EXISTS;
            }
            const handle = nextSession++;
            sessions.set(name.toUpperCase(), handle);
            writeDword(out, handle);
            writeDword((out >>> 0) + 4, 0);
            return ERROR_SUCCESS;
        },
    });

    /** @param {boolean} wide */
    const controlTrace = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([low, , nameAddress, properties, control])=>{
            if ((properties >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const named = (nameAddress >>> 0) === 0 ? null
                : readerOf(wide)(nameAddress >>> 0, MAX_NAME).toUpperCase();
            const key = named ?? [...sessions].find(([, handle])=>handle === (low >>> 0))?.[0];
            if (key === undefined || !sessions.has(key))
            {
                return ERROR_INVALID_PARAMETER;
            }
            if ((control >>> 0) === EVENT_TRACE_CONTROL_STOP)
            {
                sessions.delete(key);
            }
            return ERROR_SUCCESS;
        },
    });

    return {
        /** HANDLE RegisterEventSource(LPCTSTR lpUNCServerName, LPCTSTR lpSourceName) */
        RegisterEventSourceA: open(false, true),
        RegisterEventSourceW: open(true, true),
        /** HANDLE OpenEventLog(LPCTSTR lpUNCServerName, LPCTSTR lpSourceName) */
        OpenEventLogA: open(false, false),
        OpenEventLogW: open(true, false),
        /** HANDLE OpenBackupEventLog(LPCTSTR lpUNCServerName, LPCTSTR lpFileName) */
        OpenBackupEventLogA: openBackup(false),
        OpenBackupEventLogW: openBackup(true),

        /** BOOL DeregisterEventSource(HANDLE hEventLog) */
        DeregisterEventSource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>close(handle),
        },
        /** BOOL CloseEventLog(HANDLE hEventLog) */
        CloseEventLog: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>close(handle),
        },

        /**
         * BOOL ReportEvent(HANDLE hEventLog, WORD wType, WORD wCategory, DWORD dwEventID,
         *   PSID lpUserSid, WORD wNumStrings, DWORD dwDataSize, LPCTSTR *lpStrings,
         *   LPVOID lpRawData)
         */
        ReportEventA: report(false),
        ReportEventW: report(true),

        /**
         * BOOL ReadEventLog(HANDLE hEventLog, DWORD dwReadFlags, DWORD dwRecordOffset,
         *   LPVOID lpBuffer, DWORD nNumberOfBytesToRead, DWORD *pnBytesRead,
         *   DWORD *pnMinNumberOfBytesNeeded)
         */
        ReadEventLogA: readLog(false),
        ReadEventLogW: readLog(true),

        /** BOOL BackupEventLog(HANDLE hEventLog, LPCTSTR lpBackupFileName) */
        BackupEventLogA: backupLog(false),
        BackupEventLogW: backupLog(true),
        /** BOOL ClearEventLog(HANDLE hEventLog, LPCTSTR lpBackupFileName) */
        ClearEventLogA: clearLog(false),
        ClearEventLogW: clearLog(true),

        /** BOOL GetNumberOfEventLogRecords(HANDLE hEventLog, PDWORD NumberOfRecords) */
        GetNumberOfEventLogRecords: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const records = recordsOf(handle);
                if (!records)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeDword(out, records.length);
                return 1;
            },
        },

        /** BOOL GetOldestEventLogRecord(HANDLE hEventLog, PDWORD OldestRecord) */
        GetOldestEventLogRecord: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const records = recordsOf(handle);
                if (!records)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeDword(out, records[0]?.number ?? 0);
                return 1;
            },
        },

        /**
         * BOOL GetEventLogInformation(HANDLE hEventLog, DWORD dwInfoLevel,
         *   LPVOID lpBuffer, DWORD cbBufSize, LPDWORD pcbBytesNeeded)
         *
         * EVENTLOG_FULL_INFORMATION: no log here is ever full.
         */
        GetEventLogInformation: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, level, buffer, size, needed])=>{
                if ((level >>> 0) !== EVENTLOG_FULL_INFO)
                {
                    return fail(ERROR_INVALID_LEVEL);
                }
                if (!handleOf(handle))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((buffer >>> 0) === 0 || (needed >>> 0) === 0)
                {
                    return fail(RPC_X_NULL_REF_POINTER);
                }
                writeDword(needed, 4);
                if ((size >>> 0) < 4)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                writeDword(buffer, 0);
                return 1;
            },
        },

        /**
         * ULONG StartTrace(PTRACEHANDLE TraceHandle, LPCTSTR InstanceName,
         *   PEVENT_TRACE_PROPERTIES Properties)
         *
         * A session by its name: the properties have to be as large as they
         * say and hold the name, offsets past their fixed part, one file
         * mode, a file unless the session is real-time, and the kernel
         * logger's GUID only under its own name.
         */
        StartTraceA: startTrace(false),
        StartTraceW: startTrace(true),
        /**
         * ULONG ControlTrace(TRACEHANDLE TraceHandle, LPCTSTR InstanceName,
         *   PEVENT_TRACE_PROPERTIES Properties, ULONG ControlCode)
         */
        ControlTraceA: controlTrace(false),
        ControlTraceW: controlTrace(true),

        /**
         * ULONG EventRegister(LPCGUID ProviderId, PENABLECALLBACK, PVOID CallbackContext,
         *   PREGHANDLE RegHandle)
         */
        EventRegister: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([guid, , , out])=>{
                if ((guid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const handle = nextProvider++;
                providers.add(handle);
                writeDword(out, handle);
                writeDword((out >>> 0) + 4, 0);
                return ERROR_SUCCESS;
            },
        },
        /** ULONG EventUnregister(REGHANDLE RegHandle) */
        EventUnregister: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([low, high])=>((high >>> 0) === 0 && providers.delete(low >>> 0)
                ? ERROR_SUCCESS : ERROR_INVALID_HANDLE),
        },
        /**
         * ULONG EventWriteString(REGHANDLE RegHandle, UCHAR Level, ULONGLONG Keyword,
         *   PCWSTR String)
         *
         * Nothing here traces it, but a handle that was never registered and
         * a missing string are refused.
         */
        EventWriteString: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [low, high, , , , text])=>{
                if ((high >>> 0) !== 0 || !providers.has(low >>> 0))
                {
                    return ERROR_INVALID_HANDLE;
                }
                return (text >>> 0) === 0 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
            },
        },
    };
}

