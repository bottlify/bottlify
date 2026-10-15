/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * odbc32 — the ODBC Driver Manager of a machine with no driver and no data
 * source configured, which is what a fresh Windows is.
 *
 * An installer's helper library imports it for the database steps a package
 * may hold, and a library that does not load fails every action it serves,
 * not only those steps. Handles are made and freed as the specification
 * orders them -- an environment first, its ODBC version set, then a
 * connection, then a statement -- and every attempt to connect fails the way
 * the Driver Manager fails it when nothing names a driver: SQL_ERROR, with
 * IM002 in the handle's diagnostics.
 */

const SQL_SUCCESS = 0;
const SQL_SUCCESS_WITH_INFO = 1;
const SQL_ERROR = -1;
const SQL_INVALID_HANDLE = -2;
const SQL_NO_DATA = 100;

const SQL_HANDLE_ENV = 1;
const SQL_HANDLE_DBC = 2;
const SQL_HANDLE_STMT = 3;

const SQL_ATTR_ODBC_VERSION = 200;
const SQL_OV_ODBC2 = 2;

/** SQLFreeStmt's option that frees the statement, as SQLFreeHandle does. */
const SQL_DROP = 1;

/** What the Driver Manager says of a connection nothing names a driver for. */
const NO_SOURCE = Object.freeze({ state: 'IM002',
    text: '[Microsoft][ODBC Driver Manager] Data source name not found and no default driver '
        + 'specified' });
/** A call out of the order the specification allows. */
const SEQUENCE = Object.freeze({ state: 'HY010',
    text: '[Microsoft][ODBC Driver Manager] Function sequence error' });
/** A disconnect from a connection never opened. */
const NOT_OPEN = Object.freeze({ state: '08003',
    text: '[Microsoft][ODBC Driver Manager] Connection not open' });

/** The entries the export table carries by number, as the specification file lists them. */
export const ODBC32_ORDINALS = Object.freeze({
    1: 'SQLAllocConnect', 2: 'SQLAllocEnv', 3: 'SQLAllocStmt', 7: 'SQLConnect',
    9: 'SQLDisconnect', 10: 'SQLError', 14: 'SQLFreeConnect', 15: 'SQLFreeEnv',
    16: 'SQLFreeStmt', 24: 'SQLAllocHandle', 31: 'SQLFreeHandle', 36: 'SQLGetDiagRec',
    41: 'SQLDriverConnect', 57: 'SQLDataSources', 75: 'SQLSetEnvAttr',
});

/**
 * @typedef {Object} OdbcHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @typedef {Object} OdbcHandle
 * @property {number} type    SQL_HANDLE_ENV, _DBC or _STMT.
 * @property {number} parent  The handle it was made under; 0 for an environment.
 * @property {number} version An environment's ODBC version, 0 until set.
 * @property {{ state: string, text: string }[]} diagnostics  The last call's records.
 */

/** @param {OdbcHost} host */
export function createOdbcFunctions(host){
    /** @type {Map<number, OdbcHandle>} */
    const handles = new Map();
    // Opaque to the program, never zero, never a small integer it might mistake
    // for a handle of another kind.
    let next = 0x0d0b0000;

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address @param {number} value */
    const writeI16 = (address, value)=>{
        const bytes = new Uint8Array(2);
        new DataView(bytes.buffer).setInt16(0, value, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** @param {number} handle @param {number} [type] */
    const find = (handle, type)=>{
        const held = handles.get(handle >>> 0);
        return held && (type === undefined || held.type === type) ? held : null;
    };

    /**
     * A handle of `type` made under `parent`, written to `out`.
     *
     * @param {number} type @param {number} parent @param {number} out
     */
    const allocate = (type, parent, out)=>{
        if ((out >>> 0) === 0)
        {
            return SQL_ERROR;
        }
        const handle = next;
        next += 4;
        handles.set(handle, { type, parent: parent >>> 0, version: 0, diagnostics: [] });
        writeU32(out, handle);
        return SQL_SUCCESS;
    };

    /**
     * SQLAllocHandle's rule for each kind: an environment stands alone, a
     * connection needs an environment whose ODBC version is set, a statement a
     * connection -- open, which here none ever is.
     *
     * @param {number} type @param {number} input @param {number} out
     */
    const allocHandle = (type, input, out)=>{
        if ((out >>> 0) !== 0)
        {
            writeU32(out, 0);
        }
        if (type === SQL_HANDLE_ENV)
        {
            return allocate(type, 0, out);
        }
        if (type === SQL_HANDLE_DBC)
        {
            const environment = find(input, SQL_HANDLE_ENV);
            if (!environment)
            {
                return SQL_INVALID_HANDLE;
            }
            if (environment.version === 0)
            {
                environment.diagnostics = [SEQUENCE];
                return SQL_ERROR;
            }
            environment.diagnostics = [];
            return allocate(type, input, out);
        }
        if (type === SQL_HANDLE_STMT)
        {
            const connection = find(input, SQL_HANDLE_DBC);
            if (!connection)
            {
                return SQL_INVALID_HANDLE;
            }
            connection.diagnostics = [NOT_OPEN];
            return SQL_ERROR;
        }
        return SQL_ERROR;
    };

    /** @param {number} handle @param {number} [type] */
    const free = (handle, type)=>{
        const held = find(handle, type);
        if (!held)
        {
            return SQL_INVALID_HANDLE;
        }
        // A handle with others made under it is still in use.
        if ([...handles.values()].some(child=>child.parent === (handle >>> 0)))
        {
            held.diagnostics = [SEQUENCE];
            return SQL_ERROR;
        }
        handles.delete(handle >>> 0);
        return SQL_SUCCESS;
    };

    /** @param {number} connection */
    const connect = connection=>{
        const held = find(connection, SQL_HANDLE_DBC);
        if (!held)
        {
            return SQL_INVALID_HANDLE;
        }
        held.diagnostics = [NO_SOURCE];
        return SQL_ERROR;
    };

    /**
     * One diagnostic record written out as SQLGetDiagRec and SQLError write
     * it: the five-letter state and its terminator, the native error (none
     * from the Driver Manager itself), the message cut to the buffer, and its
     * whole length. A message cut short is SQL_SUCCESS_WITH_INFO.
     *
     * @param {{ state: string, text: string }} record
     * @param {number} state @param {number} native @param {number} message
     * @param {number} room @param {number} length
     */
    const writeRecord = (record, state, native, message, room, length)=>{
        if ((state >>> 0) !== 0)
        {
            host.writeMemory(state >>> 0, Uint8Array.from([...record.state, '\0']
                .map(ch=>ch.charCodeAt(0))));
        }
        if ((native >>> 0) !== 0)
        {
            writeU32(native, 0);
        }
        if ((length >>> 0) !== 0)
        {
            writeI16(length, record.text.length);
        }
        const fits = (room | 0) > record.text.length;
        if ((message >>> 0) !== 0 && (room | 0) > 0)
        {
            const kept = record.text.slice(0, (room | 0) - 1);
            host.writeMemory(message >>> 0, Uint8Array.from([...kept, '\0']
                .map(ch=>ch.charCodeAt(0) & 0xff)));
        }
        return fits ? SQL_SUCCESS : SQL_SUCCESS_WITH_INFO;
    };

    return {
        /** SQLRETURN SQLAllocEnv(SQLHENV *EnvironmentHandle): ODBC 2's, its version so set. */
        SQLAllocEnv: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                const code = allocHandle(SQL_HANDLE_ENV, 0, out);
                const made = code === SQL_SUCCESS ? handles.get(next - 4) : undefined;
                if (made)
                {
                    made.version = SQL_OV_ODBC2;
                }
                return code;
            },
        },
        /** SQLRETURN SQLAllocConnect(SQLHENV, SQLHDBC *) */
        SQLAllocConnect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([environment, out])=>allocHandle(SQL_HANDLE_DBC, environment, out),
        },
        /** SQLRETURN SQLAllocStmt(SQLHDBC, SQLHSTMT *) */
        SQLAllocStmt: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([connection, out])=>allocHandle(SQL_HANDLE_STMT, connection, out),
        },
        /** SQLRETURN SQLAllocHandle(SQLSMALLINT HandleType, SQLHANDLE InputHandle, SQLHANDLE *) */
        SQLAllocHandle: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([type, input, out])=>allocHandle(type << 16 >> 16, input, out),
        },
        /** SQLRETURN SQLSetEnvAttr(SQLHENV, SQLINTEGER Attribute, SQLPOINTER Value, SQLINTEGER) */
        SQLSetEnvAttr: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([environment, attribute, value])=>{
                const held = find(environment, SQL_HANDLE_ENV);
                if (!held)
                {
                    return SQL_INVALID_HANDLE;
                }
                if ((attribute | 0) === SQL_ATTR_ODBC_VERSION)
                {
                    held.version = value >>> 0;
                }
                return SQL_SUCCESS;
            },
        },
        /** SQLRETURN SQLFreeHandle(SQLSMALLINT HandleType, SQLHANDLE Handle) */
        SQLFreeHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([type, handle])=>free(handle, type << 16 >> 16),
        },
        /** SQLRETURN SQLFreeEnv(SQLHENV) */
        SQLFreeEnv: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>free(handle, SQL_HANDLE_ENV),
        },
        /** SQLRETURN SQLFreeConnect(SQLHDBC) */
        SQLFreeConnect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>free(handle, SQL_HANDLE_DBC),
        },
        /** SQLRETURN SQLFreeStmt(SQLHSTMT, SQLUSMALLINT Option) */
        SQLFreeStmt: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, option])=>((option & 0xffff) === SQL_DROP
                ? free(handle, SQL_HANDLE_STMT)
                : find(handle, SQL_HANDLE_STMT) ? SQL_SUCCESS : SQL_INVALID_HANDLE),
        },
        /** SQLRETURN SQLConnect(SQLHDBC, SQLCHAR *ServerName, ..., 7 arguments) */
        SQLConnect: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([connection])=>connect(connection),
        },
        /** SQLRETURN SQLDriverConnect(SQLHDBC, SQLHWND, SQLCHAR *In, ..., 8 arguments) */
        SQLDriverConnect: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([connection])=>connect(connection),
        },
        /** SQLRETURN SQLDisconnect(SQLHDBC): nothing is ever open. */
        SQLDisconnect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([connection])=>{
                const held = find(connection, SQL_HANDLE_DBC);
                if (!held)
                {
                    return SQL_INVALID_HANDLE;
                }
                held.diagnostics = [NOT_OPEN];
                return SQL_ERROR;
            },
        },
        /**
         * SQLRETURN SQLDataSources(SQLHENV, SQLUSMALLINT Direction, ..., 8 arguments):
         * the list of data sources, which holds none.
         */
        SQLDataSources: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([environment])=>(find(environment, SQL_HANDLE_ENV)
                ? SQL_NO_DATA : SQL_INVALID_HANDLE),
        },
        /**
         * SQLRETURN SQLGetDiagRec(SQLSMALLINT HandleType, SQLHANDLE, SQLSMALLINT RecNumber,
         *     SQLCHAR *SQLState, SQLINTEGER *NativeError, SQLCHAR *MessageText,
         *     SQLSMALLINT BufferLength, SQLSMALLINT *TextLength)
         */
        SQLGetDiagRec: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([type, handle, number, state, native, message, room, length])=>{
                const held = find(handle, type << 16 >> 16);
                if (!held)
                {
                    return SQL_INVALID_HANDLE;
                }
                const record = held.diagnostics[(number << 16 >> 16) - 1];
                if ((number << 16 >> 16) < 1 || !record)
                {
                    return SQL_NO_DATA;
                }
                return writeRecord(record, state, native, message, room << 16 >> 16, length);
            },
        },
        /**
         * SQLRETURN SQLError(SQLHENV, SQLHDBC, SQLHSTMT, SQLCHAR *SQLState,
         *     SQLINTEGER *NativeError, SQLCHAR *MessageText, SQLSMALLINT BufferLength,
         *     SQLSMALLINT *TextLength): ODBC 2's, the innermost handle given asked, and
         * the record it answers taken off it.
         */
        SQLError: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([environment, connection, statement, state, native, message, room,
                length])=>{
                const handle = [statement, connection, environment].find(each=>(each >>> 0) !== 0);
                const held = handle === undefined ? null : find(handle);
                if (!held)
                {
                    return SQL_INVALID_HANDLE;
                }
                const record = held.diagnostics.shift();
                return record
                    ? writeRecord(record, state, native, message, room << 16 >> 16, length)
                    : SQL_NO_DATA;
            },
        },
    };
}
