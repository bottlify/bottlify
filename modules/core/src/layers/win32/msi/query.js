/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Views: a statement prepared against a database, executed with its
 * parameters, its rows fetched one record at a time and changed through the
 * view they came from.
 *
 * The answers follow the installer's own rather than SQL's. Strings compare
 * only for equality, and a null string equals an empty one; an integer
 * column's null compares below every value; ORDER BY on a string column
 * orders by the string's number in the pool, not by its text; rows come back
 * in the order the table keeps them, which is its keys' order. A session's
 * database is read-only, and in one only a temporary row or table may be
 * added, changed or dropped.
 */

import { MSITYPE, isBinaryType, isKey, isStringType } from './database.js';
import { SqlError, parseStatement } from './sql.js';
import {
    MSI_NULL_INTEGER, createRecord, getInteger, getString, isNull,
} from './record.js';

export const ERROR_SUCCESS = 0;
export const ERROR_INVALID_PARAMETER = 87;
export const ERROR_NO_MORE_ITEMS = 259;
export const ERROR_FUNCTION_FAILED = 1627;
export const ERROR_INVALID_DATA = 13;
export const ERROR_BAD_QUERY_SYNTAX = 1615;
export const ERROR_INVALID_FIELD = 1616;

/** MsiViewModify's modes. */
export const MSIMODIFY = Object.freeze({
    SEEK: -1, REFRESH: 0, INSERT: 1, UPDATE: 2, ASSIGN: 3, REPLACE: 4, MERGE: 5, DELETE: 6,
    INSERT_TEMPORARY: 7, VALIDATE: 8, VALIDATE_NEW: 9, VALIDATE_FIELD: 10, VALIDATE_DELETE: 11,
});

/** The pseudo-table every stream that is not a table's is a row of. */
const STREAMS_TABLE = '_Streams';

/**
 * @typedef {import('./database.js').Database} Database
 * @typedef {import('./database.js').Table} Table
 * @typedef {import('./database.js').Row} Row
 * @typedef {import('./database.js').Column} Column
 * @typedef {import('./record.js').Record} Record
 */

/**
 * A column of a view: where its value comes from in the joined tables, or a
 * string the statement names.
 *
 * @typedef {{ table: number, index: number, column: Column } | { literal: string }} ViewColumn
 */

/**
 * @typedef {Object} View
 * @property {ViewColumn[]} columns
 * @property {(params: Record | null) => number} execute
 * @property {() => Record | null} fetch  null once the rows are spent.
 * @property {(mode: number, record: Record) => number} modify
 * @property {() => void} close
 * @property {boolean} executed
 * @property {string} kind
 */

/** @param {Column} column */
const integerNull = column=>((column.type & MSITYPE.SIZE) === 4 ? MSI_NULL_INTEGER : -0x8000);

/**
 * A table's rows for a view, and the pseudo-table of streams built afresh.
 *
 * @param {Database} db @param {string} name @returns {Table | null}
 */
function tableFor(db, name){
    if (name === STREAMS_TABLE)
    {
        return {
            name,
            columns: [
                { table: name, number: 1, name: 'Name',
                    type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.KEY | 62 },
                { table: name, number: 2, name: 'Data', type: MSITYPE.VALID | MSITYPE.STRING },
            ],
            rows: db.streamNames().sort().map(stream=>[stream, stream]),
            temporary: false, temporaryRows: new Set(), hold: 0,
        };
    }
    return db.table(name);
}

/**
 * A record for a row: integers and strings as they are, a binary column as
 * the stream it names.
 *
 * @param {Database} db @param {{ column: Column, value: string | number | null }[]} values
 */
function recordOf(db, values){
    const record = createRecord(values.length);
    values.forEach(({ column, value }, index)=>{
        if (value === null)
        {
            return;
        }
        if (isBinaryType(column.type) || (column.table === STREAMS_TABLE && column.number === 2))
        {
            const name = String(value);
            const size = db.streamSize(name);
            if (size !== null)
            {
                record.fields[index + 1] = {
                    stream: { size, read: (offset, length)=>db.readStreamRange(name, offset, length)
                        .then(bytes=>bytes ?? new Uint8Array(0)) },
                    position: 0,
                };
            }
            return;
        }
        record.fields[index + 1] = value;
    });
    return record;
}

/**
 * A field of a record as a column stores it, or undefined when it cannot be.
 *
 * @param {Column} column @param {Record} record @param {number} index
 * @returns {string | number | null | undefined}
 */
function storedValue(column, record, index){
    if (isNull(record, index))
    {
        return null;
    }
    if (isBinaryType(column.type))
    {
        // The stream itself is written by the caller; the row only says one is there.
        return '';
    }
    if (isStringType(column.type))
    {
        return getString(record, index);
    }
    const value = getInteger(record, index);
    return value === MSI_NULL_INTEGER ? undefined : value;
}

/**
 * Where a new row goes: after every row whose keys sort before it, keys
 * compared as the pool and the integer encoding store them.
 *
 * @param {Database} db @param {Table} table @param {Row} row
 */
function insertIndex(db, table, row){
    const keys = table.columns.map((column, index)=>(isKey(column) ? index : -1))
        .filter(index=>index >= 0);
    /** @param {Row} left @param {Row} right */
    const compare = (left, right)=>{
        for (const index of keys)
        {
            const a = rank(db, table.columns[index], left[index]);
            const b = rank(db, table.columns[index], right[index]);
            if (a !== b)
            {
                return a < b ? -1 : 1;
            }
        }
        return 0;
    };
    let low = 0;
    let high = table.rows.length;
    while (low < high)
    {
        const middle = (low + high) >> 1;
        if (compare(table.rows[middle], row) <= 0)
        {
            low = middle + 1;
        }
        else
        {
            high = middle;
        }
    }
    return low;
}

/**
 * A value as the table stores it, for ordering: a string by its number in the
 * pool, an integer by its biased encoding, null below everything.
 *
 * @param {Database} db @param {Column} column @param {string | number | null} value
 */
function rank(db, column, value){
    if (value === null)
    {
        return -Infinity;
    }
    if (typeof value === 'string')
    {
        return isStringType(column.type) ? db.stringId(value) : 0;
    }
    return value;
}

/**
 * Gives every string a row holds its number in the pool, as storing it does:
 * a string's place in a later ORDER BY is the place it arrived in.
 *
 * @param {Database} db @param {Row} row
 */
const intern = (db, row)=>{
    for (const value of row)
    {
        if (typeof value === 'string' && value !== '')
        {
            db.stringId(value);
        }
    }
};

/** @param {Table} table @param {Row} row */
const keyOf = (table, row)=>table.columns.map((column, index)=>(isKey(column)
    ? JSON.stringify(row[index]) : '')).join('\u0000');

/**
 * Adds a row, refusing one whose keys another row has.
 *
 * @param {Database} db @param {Table} table @param {Row} row @param {boolean} temporary
 * @returns {number}
 */
export function insertRow(db, table, row, temporary){
    if (db.readOnly && !temporary && !table.temporary)
    {
        return ERROR_FUNCTION_FAILED;
    }
    const key = keyOf(table, row);
    if (table.rows.some(existing=>keyOf(table, existing) === key))
    {
        return ERROR_FUNCTION_FAILED;
    }
    for (const [index, column] of table.columns.entries())
    {
        if (row[index] === null && (column.type & MSITYPE.NULLABLE) === 0 && isKey(column))
        {
            return ERROR_FUNCTION_FAILED;
        }
    }
    intern(db, row);
    table.rows.splice(insertIndex(db, table, row), 0, row);
    if (temporary || table.temporary)
    {
        table.temporaryRows.add(row);
    }
    return ERROR_SUCCESS;
}

/** @param {Database} db @param {Table} table @param {Row} row */
function removeRow(db, table, row){
    if (db.readOnly && !table.temporary && !table.temporaryRows.has(row))
    {
        return ERROR_FUNCTION_FAILED;
    }
    const at = table.rows.indexOf(row);
    if (at < 0)
    {
        return ERROR_FUNCTION_FAILED;
    }
    table.rows.splice(at, 1);
    table.temporaryRows.delete(row);
    return ERROR_SUCCESS;
}

/**
 * Prepares a statement. Errors that MsiDatabaseOpenView reports are answered
 * here: a statement that does not parse, a table or column that is not there.
 *
 * @param {Database} db @param {string} text
 * @returns {{ view: View } | { error: number }}
 */
export function openView(db, text){
    let statement;
    try
    {
        statement = parseStatement(text);
    }
    catch (e){
        if (e instanceof SqlError)
        {
            return { error: ERROR_BAD_QUERY_SYNTAX };
        }
        throw e;
    }
    try
    {
        switch (statement.kind)
        {
            case 'select': return { view: selectView(db, statement) };
            case 'delete': return { view: deleteView(db, statement) };
            case 'insert': return { view: insertView(db, statement) };
            case 'update': return { view: updateView(db, statement) };
            case 'create': return { view: createView(db, statement) };
            case 'alter': return { view: alterView(db, statement) };
            case 'drop': return { view: dropView(db, statement) };
        }
    }
    catch (e){
        if (e instanceof SqlError)
        {
            return { error: ERROR_BAD_QUERY_SYNTAX };
        }
        throw e;
    }
    return { error: ERROR_BAD_QUERY_SYNTAX };
}

/**
 * The tables a statement names, and a column reference resolved to one of
 * them.
 *
 * @param {Database} db @param {string[]} names
 */
function bindTables(db, names){
    const tables = names.map(name=>{
        const table = tableFor(db, name);
        if (!table)
        {
            throw new SqlError(`no table ${name}`);
        }
        return table;
    });
    /**
     * @param {import('./sql.js').ColumnRef} ref
     * @returns {{ table: number, index: number, column: Column }}
     */
    const resolve = ref=>{
        /** @type {{ table: number, index: number, column: Column } | null} */
        let found = null;
        tables.forEach((table, tableIndex)=>{
            if (ref.table !== null && ref.table !== table.name)
            {
                return;
            }
            const index = table.columns.findIndex(column=>column.name === ref.name);
            if (index >= 0 && !found)
            {
                found = { table: tableIndex, index, column: table.columns[index] };
            }
        });
        if (!found)
        {
            throw new SqlError(`no column ${ref.name}`);
        }
        return found;
    };
    return { tables, resolve };
}

/**
 * A WHERE clause as a function of the joined rows and the parameters, the
 * parameters taken in the order the clause names them.
 *
 * @param {import('./sql.js').Expression | null} expression
 * @param {(ref: import('./sql.js').ColumnRef) => { table: number, index: number,
 *     column: Column }} resolve
 * @returns {(rows: Row[], params: Record | null) => boolean}
 */
function compileWhere(expression, resolve){
    if (!expression)
    {
        return ()=>true;
    }
    /** @type {{ next: number }} */
    const cursor = { next: 0 };
    /**
     * @param {import('./sql.js').Expression} node
     * @returns {(rows: Row[], params: Record | null) => boolean}
     */
    const compile = node=>{
        if (node.kind === 'and' || node.kind === 'or')
        {
            const left = compile(node.left);
            const right = compile(node.right);
            return node.kind === 'and' ? (rows, params)=>left(rows, params) && right(rows, params)
                : (rows, params)=>left(rows, params) || right(rows, params);
        }
        if (node.kind === 'null' || node.kind === 'notnull')
        {
            const { table, index } = resolve(node.column);
            const want = node.kind === 'null';
            return rows=>(rows[table][index] === null) === want;
        }
        if (node.kind !== 'compare')
        {
            throw new SqlError('not a comparison');
        }
        const left = resolve(node.left);
        const op = node.op;
        const stringy = isStringType(left.column.type) || isBinaryType(left.column.type);
        /** @type {(rows: Row[], params: Record | null) => string | number | null} */
        let right;
        if ('column' in node.right)
        {
            const other = resolve(node.right.column);
            right = rows=>rows[other.table][other.index];
        }
        else
        {
            const constant = node.right.constant;
            if (constant.kind === 'parameter')
            {
                const slot = ++cursor.next;
                right = (_rows, params)=>{
                    if (!params)
                    {
                        return null;
                    }
                    if (stringy)
                    {
                        return getString(params, slot) || null;
                    }
                    const value = getInteger(params, slot);
                    return value === MSI_NULL_INTEGER ? null : value;
                };
            }
            else
            {
                const value = constant.kind === 'null' ? null : constant.value;
                right = ()=>value;
            }
        }
        if (stringy)
        {
            if (op !== '=' && op !== '<>')
            {
                return ()=>false;
            }
            return (rows, params)=>{
                const a = rows[left.table][left.index] ?? '';
                const b = right(rows, params) ?? '';
                return (String(a) === String(b)) === (op === '=');
            };
        }
        const nullValue = integerNull(left.column);
        return (rows, params)=>{
            const raw = rows[left.table][left.index];
            const a = typeof raw === 'number' ? raw : nullValue;
            const other = right(rows, params);
            const b = typeof other === 'number' ? other
                : other === null ? nullValue : Number(other) | 0;
            switch (op)
            {
                case '=': return a === b;
                case '<>': return a !== b;
                case '<': return a < b;
                case '>': return a > b;
                case '<=': return a <= b;
                default: return a >= b;
            }
        };
    };
    return compile(expression);
}

/**
 * The rows of the tables joined, filtered by the clause, in the order the
 * statement asks for.
 *
 * @param {Database} db @param {Table[]} tables
 * @param {(rows: Row[], params: Record | null) => boolean} where
 * @param {{ table: number, index: number, column: Column }[]} order
 * @param {Record | null} params
 */
function selectRows(db, tables, where, order, params){
    /** @type {Row[][]} */
    let results = [[]];
    for (const table of tables)
    {
        /** @type {Row[][]} */
        const next = [];
        for (const partial of results)
        {
            for (const row of table.rows)
            {
                next.push([...partial, row]);
            }
        }
        results = next;
    }
    const matched = results.filter(rows=>where(rows, params));
    if (order.length > 0)
    {
        const positions = new Map(matched.map((rows, index)=>[rows, index]));
        matched.sort((left, right)=>{
            for (const { table, index, column } of order)
            {
                const a = rank(db, column, left[table][index]);
                const b = rank(db, column, right[table][index]);
                if (a !== b)
                {
                    return a < b ? -1 : 1;
                }
            }
            return /** @type {number} */ (positions.get(left))
                - /** @type {number} */ (positions.get(right));
        });
    }
    return matched;
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'select' }>} statement
 * @returns {View}
 */
function selectView(db, statement){
    const { tables, resolve } = bindTables(db, statement.tables);
    /** @type {ViewColumn[]} */
    const columns = statement.columns === null
        ? tables.flatMap((table, tableIndex)=>table.columns.map((column, index)=>
            ({ table: tableIndex, index, column })))
        : statement.columns.map(entry=>('string' in entry ? { literal: entry.string }
            : resolve(entry)));
    const where = compileWhere(statement.where, resolve);
    const order = statement.order.map(resolve);
    /** @type {Row[][]} */
    let results = [];
    let next = 0;
    /** @type {WeakMap<Record, Row[]>} */
    const origins = new WeakMap();

    /** @param {Row[]} rows */
    const valuesOf = rows=>columns.map(entry=>('literal' in entry
        ? { column: /** @type {Column} */ ({ table: '', number: 0, name: '', type: MSITYPE.STRING }),
            value: entry.literal }
        : { column: entry.column, value: rows[entry.table][entry.index] }));

    /** The one table a modify may change: a view of a single table, without literals. */
    const single = tables.length === 1 && columns.every(entry=>!('literal' in entry))
        ? tables[0] : null;

    /**
     * The row of the single table whose keys the record's fields give, when
     * the view holds every key.
     *
     * @param {Record} record
     */
    const rowByKey = record=>{
        if (!single)
        {
            return undefined;
        }
        const keys = single.columns.map((column, index)=>(isKey(column) ? index : -1))
            .filter(index=>index >= 0);
        const fieldOf = (/** @type {number} */ tableColumn)=>columns.findIndex(entry=>
            'index' in entry && entry.index === tableColumn) + 1;
        if (keys.some(index=>fieldOf(index) === 0))
        {
            return undefined;
        }
        return single.rows.find(row=>keys.every(index=>{
            const value = storedValue(single.columns[index], record, fieldOf(index));
            return (row[index] ?? null) === (value ?? null);
        })) ?? null;
    };

    /**
     * The row a record would be: the view's fields where it has them, null
     * elsewhere; undefined when a field cannot be stored.
     *
     * @param {Record} record @param {Row} [base]
     */
    const rowOf = (record, base)=>{
        const table = /** @type {Table} */ (single);
        /** @type {Row} */
        const row = base ? [...base] : new Array(table.columns.length).fill(null);
        for (const [field, entry] of columns.entries())
        {
            if (!('index' in entry))
            {
                continue;
            }
            const value = storedValue(entry.column, record, field + 1);
            if (value === undefined)
            {
                return undefined;
            }
            row[entry.index] = value;
        }
        return row;
    };

    /** @type {View} */
    const view = {
        kind: 'select',
        columns,
        executed: false,
        execute: params=>{
            results = selectRows(db, tables.map(table=>(table.name === STREAMS_TABLE
                ? /** @type {Table} */ (tableFor(db, STREAMS_TABLE)) : table)), where, order, params);
            if (statement.distinct)
            {
                const seen = new Set();
                results = results.filter(rows=>{
                    const key = JSON.stringify(valuesOf(rows).map(entry=>entry.value));
                    if (seen.has(key))
                    {
                        return false;
                    }
                    seen.add(key);
                    return true;
                });
            }
            next = 0;
            view.executed = true;
            return ERROR_SUCCESS;
        },
        fetch: ()=>{
            if (next >= results.length)
            {
                return null;
            }
            const rows = results[next++];
            const record = recordOf(db, valuesOf(rows));
            origins.set(record, rows);
            return record;
        },
        modify: (mode, record)=>{
            if (!single)
            {
                return ERROR_FUNCTION_FAILED;
            }
            const table = single;
            const fetched = origins.get(record)?.[0] ?? null;
            switch (mode)
            {
                case MSIMODIFY.SEEK:
                case MSIMODIFY.REFRESH:
                {
                    const row = mode === MSIMODIFY.REFRESH ? fetched : rowByKey(record);
                    if (!row || !table.rows.includes(row))
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    const fresh = recordOf(db, valuesOf([row]));
                    record.fields.splice(0, record.fields.length, ...fresh.fields);
                    origins.set(record, [row]);
                    return ERROR_SUCCESS;
                }
                case MSIMODIFY.INSERT:
                case MSIMODIFY.INSERT_TEMPORARY:
                {
                    const row = rowOf(record);
                    if (!row)
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    const code = insertRow(db, table, row, mode === MSIMODIFY.INSERT_TEMPORARY);
                    if (code === ERROR_SUCCESS)
                    {
                        origins.set(record, [row]);
                    }
                    return code;
                }
                case MSIMODIFY.UPDATE:
                {
                    if (!fetched || !table.rows.includes(fetched))
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    const row = rowOf(record, fetched);
                    if (!row || keyOf(table, row) !== keyOf(table, fetched))
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    if (db.readOnly && !table.temporary && !table.temporaryRows.has(fetched))
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    intern(db, row);
                    fetched.splice(0, fetched.length, ...row);
                    return ERROR_SUCCESS;
                }
                case MSIMODIFY.ASSIGN:
                case MSIMODIFY.REPLACE:
                case MSIMODIFY.MERGE:
                {
                    const existing = rowByKey(record);
                    if (existing === undefined)
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    const row = rowOf(record);
                    if (!row)
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    if (existing === null)
                    {
                        return insertRow(db, table, row, false);
                    }
                    if (mode === MSIMODIFY.MERGE)
                    {
                        return JSON.stringify(rowOf(record, existing)) === JSON.stringify(existing)
                            ? ERROR_SUCCESS : ERROR_FUNCTION_FAILED;
                    }
                    if (db.readOnly && !table.temporary && !table.temporaryRows.has(existing))
                    {
                        return ERROR_FUNCTION_FAILED;
                    }
                    existing.splice(0, existing.length,
                        .../** @type {Row} */ (mode === MSIMODIFY.ASSIGN
                            ? rowOf(record, existing) : row));
                    return ERROR_SUCCESS;
                }
                case MSIMODIFY.DELETE:
                {
                    const row = fetched ?? rowByKey(record);
                    return row ? removeRow(db, table, row) : ERROR_FUNCTION_FAILED;
                }
                case MSIMODIFY.VALIDATE:
                case MSIMODIFY.VALIDATE_NEW:
                case MSIMODIFY.VALIDATE_FIELD:
                case MSIMODIFY.VALIDATE_DELETE:
                    return ERROR_SUCCESS;
                default:
                    return ERROR_INVALID_DATA;
            }
        },
        close: ()=>{
            results = [];
            next = 0;
            view.executed = false;
        },
    };
    return view;
}

/**
 * A view whose work is all done on execute; it has no rows to fetch.
 *
 * @param {string} kind @param {(params: Record | null) => number} run
 * @param {ViewColumn[]} [columns]
 * @returns {View}
 */
function actionView(kind, run, columns = []){
    /** @type {View} */
    const view = {
        kind,
        columns,
        executed: false,
        execute: params=>{
            view.executed = true;
            return run(params);
        },
        fetch: ()=>null,
        modify: ()=>ERROR_FUNCTION_FAILED,
        close: ()=>{
            view.executed = false;
        },
    };
    return view;
}

/**
 * A constant as a column stores it, a parameter taken from the record.
 *
 * @param {Column} column @param {import('./sql.js').Constant} constant
 * @param {Record | null} params @param {{ next: number }} cursor
 * @returns {string | number | null | undefined}
 */
function constantValue(column, constant, params, cursor){
    if (constant.kind === 'parameter')
    {
        const slot = ++cursor.next;
        if (!params)
        {
            return null;
        }
        if (isStringType(column.type))
        {
            return getString(params, slot) || null;
        }
        if (isBinaryType(column.type))
        {
            return isNull(params, slot) ? null : '';
        }
        const value = getInteger(params, slot);
        return value === MSI_NULL_INTEGER ? null : value;
    }
    if (constant.kind === 'null')
    {
        return null;
    }
    if (isStringType(column.type))
    {
        return constant.kind === 'string' ? constant.value || null : String(constant.value);
    }
    if (constant.kind === 'string')
    {
        return undefined;
    }
    return constant.value | 0;
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'insert' }>} statement
 */
function insertView(db, statement){
    const table = tableFor(db, statement.table);
    if (!table)
    {
        throw new SqlError('no table');
    }
    const targets = statement.columns.map(name=>{
        const index = table.columns.findIndex(column=>column.name === name);
        if (index < 0)
        {
            throw new SqlError(`no column ${name}`);
        }
        return index;
    });
    return actionView('insert', params=>{
        /** @type {Row} */
        const row = new Array(table.columns.length).fill(null);
        const cursor = { next: 0 };
        for (const [position, index] of targets.entries())
        {
            const value = constantValue(table.columns[index], statement.values[position], params,
                cursor);
            if (value === undefined)
            {
                return ERROR_FUNCTION_FAILED;
            }
            row[index] = value;
        }
        if (table.name === STREAMS_TABLE)
        {
            return ERROR_FUNCTION_FAILED;
        }
        return insertRow(db, table, row, statement.temporary);
    });
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'update' }>} statement
 */
function updateView(db, statement){
    const { tables, resolve } = bindTables(db, [statement.table]);
    const table = tables[0];
    const targets = statement.set.map(({ column })=>resolve({ table: null, name: column }).index);
    // The values come before the clause's parameters, in the order written.
    const where = compileWhere(statement.where, resolve);
    return actionView('update', params=>{
        const cursor = { next: 0 };
        const values = statement.set.map(({ value }, position)=>constantValue(
            table.columns[targets[position]], value, params, cursor));
        if (values.some(value=>value === undefined))
        {
            return ERROR_FUNCTION_FAILED;
        }
        // The clause's parameters follow the SET list's in the record.
        const shifted = params ? { fields: [params.fields[0],
            ...params.fields.slice(cursor.next + 1)] } : null;
        for (const row of table.rows.filter(candidate=>where([candidate], shifted)))
        {
            if (db.readOnly && !table.temporary && !table.temporaryRows.has(row))
            {
                return ERROR_FUNCTION_FAILED;
            }
            targets.forEach((index, position)=>{
                row[index] = /** @type {string | number | null} */ (values[position]);
            });
            intern(db, row);
        }
        return ERROR_SUCCESS;
    });
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'delete' }>} statement
 */
function deleteView(db, statement){
    const { tables, resolve } = bindTables(db, statement.tables);
    if (tables.length !== 1)
    {
        throw new SqlError('one table');
    }
    const where = compileWhere(statement.where, resolve);
    return actionView('delete', params=>{
        for (const row of tables[0].rows.filter(candidate=>where([candidate], params)))
        {
            const code = removeRow(db, tables[0], row);
            if (code !== ERROR_SUCCESS)
            {
                return code;
            }
        }
        return ERROR_SUCCESS;
    });
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'create' }>} statement
 */
function createView(db, statement){
    if (db.table(statement.table) || statement.table === STREAMS_TABLE)
    {
        throw new SqlError('the table is there');
    }
    return actionView('create', ()=>{
        if (db.table(statement.table))
        {
            return ERROR_BAD_QUERY_SYNTAX;
        }
        if (db.readOnly && !statement.temporary)
        {
            return ERROR_FUNCTION_FAILED;
        }
        db.tables.set(statement.table, {
            name: statement.table,
            columns: statement.columns.map((column, index)=>({
                table: statement.table, number: index + 1, name: column.name, type: column.type,
            })),
            rows: [],
            temporary: statement.temporary,
            temporaryRows: new Set(),
            hold: statement.hold ? 1 : 0,
        });
        return ERROR_SUCCESS;
    });
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'alter' }>} statement
 */
function alterView(db, statement){
    const table = db.table(statement.table);
    if (!table)
    {
        throw new SqlError('no table');
    }
    return actionView('alter', ()=>{
        if (statement.op === 'add' && statement.column)
        {
            const added = statement.column;
            if (table.columns.some(column=>column.name === added.name))
            {
                return ERROR_BAD_QUERY_SYNTAX;
            }
            if (db.readOnly && !table.temporary && (added.type & MSITYPE.TEMPORARY) === 0)
            {
                return ERROR_FUNCTION_FAILED;
            }
            table.columns.push({ table: table.name, number: table.columns.length + 1,
                name: added.name, type: added.type });
            for (const row of table.rows)
            {
                row.push(null);
            }
        }
        if (statement.hold)
        {
            table.hold++;
        }
        else if (statement.op === 'free')
        {
            table.hold = Math.max(0, table.hold - 1);
            if (table.hold === 0 && table.temporary)
            {
                db.tables.delete(table.name);
            }
        }
        return ERROR_SUCCESS;
    });
}

/**
 * @param {Database} db
 * @param {Extract<import('./sql.js').Statement, { kind: 'drop' }>} statement
 */
function dropView(db, statement){
    if (!db.table(statement.table))
    {
        throw new SqlError('no table');
    }
    return actionView('drop', ()=>{
        const table = db.table(statement.table);
        if (!table)
        {
            return ERROR_FUNCTION_FAILED;
        }
        if (db.readOnly && !table.temporary)
        {
            return ERROR_FUNCTION_FAILED;
        }
        db.tables.delete(statement.table);
        return ERROR_SUCCESS;
    });
}

/**
 * MsiViewGetColumnInfo's answer: a column's name, or its type spelled as a
 * letter and a size -- s, l, v, i, g and j as the column is a string, a
 * localizable one, a stream, an integer or a temporary one, upper case when
 * it may be null.
 *
 * @param {ViewColumn[]} columns @param {Table[] | null} tables
 * @param {'names' | 'types'} kind
 */
export function columnInfo(columns, tables, kind){
    const record = createRecord(columns.length);
    columns.forEach((entry, index)=>{
        if ('literal' in entry)
        {
            record.fields[index + 1] = kind === 'names' ? entry.literal : 's0';
            return;
        }
        const { column } = entry;
        if (kind === 'names')
        {
            record.fields[index + 1] = column.name;
            return;
        }
        const temporary = tables?.[entry.table]?.temporary
            || (column.type & MSITYPE.TEMPORARY) !== 0;
        let letter = isBinaryType(column.type) ? 'v'
            : (column.type & MSITYPE.LOCALIZABLE) !== 0 ? 'l'
                : (column.type & MSITYPE.STRING) !== 0 ? (temporary ? 'g' : 's')
                    : (temporary ? 'j' : 'i');
        if ((column.type & MSITYPE.NULLABLE) !== 0)
        {
            letter = letter.toUpperCase();
        }
        record.fields[index + 1] = `${letter}${column.type & MSITYPE.SIZE}`;
    });
    return record;
}
