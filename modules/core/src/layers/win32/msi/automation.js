/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Windows Installer's automation objects, as a script custom action sees
 * them: Session, and through it Installer, Database, View and Record --
 * members by the names and with the answers the installer's object model
 * documents, built on the engine's own session, database and records.
 *
 * Each is an external object of the scripting runtime: a member a script
 * reads is `get`, one it assigns is `put` (Session.Property("X") = "1"), and
 * a member with arguments may be called or read alike. A failure is thrown as
 * an ExternalError with the HRESULT the installer's objects raise, which the
 * script sees as a catchable error.
 */

import { hostObject, ExternalError, DISP_E_TYPEMISMATCH, E_FAIL } from '../script/external.js';
import { MSICONDITION } from './condition.js';
import { INSTALLSTATE } from './session.js';
import {
    createRecord, fieldCount, getInteger, getString, isNull, setInteger, setString, dataSize,
    clearRecord,
} from './record.js';
import { columnInfo, openView, ERROR_SUCCESS } from './query.js';
import { installerVersion } from './version.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('../script/external.js').ExternalObject} ExternalObject */

/** The run modes a script names by number, as MsiGetMode numbers them. */
const RUN_MODES = Object.freeze({
    0: 'admin', 1: 'advertise', 2: 'maintenance', 3: 'rollbackEnabled', 4: 'logEnabled',
    5: 'operations', 6: 'rebootAtEnd', 7: 'rebootNow', 8: 'cabinet', 9: 'sourceShortNames',
    10: 'targetShortNames', 12: 'windows9x', 13: 'zawEnabled', 16: 'scheduled',
    17: 'rollback', 18: 'commit',
});

/** msiDoActionStatus: what Session.DoAction answers for each of an action's codes. */
const DO_ACTION_STATUS = new Map([[0, 1], [1602, 2], [1603, 3], [1604, 4], [259, 5],
    [1626, 0]]);

/** The error an object raises for a call the installer refused. */
const failed = ()=>new ExternalError(E_FAIL, 'The installer refused the call.');

/** @param {unknown} value @returns {number} */
const integer = value=>{
    const number = Number(value);
    if (!Number.isFinite(number))
    {
        throw new ExternalError(DISP_E_TYPEMISMATCH);
    }
    return Math.trunc(number);
};

/** @param {unknown} value */
const text = value=>(value === null || value === undefined ? '' : String(value));

/** The records a Record object stands for, kept to hand them back to the engine. */
const records = new WeakMap();

/**
 * A Record object over one of the engine's records.
 *
 * @param {import('./record.js').Record} record
 * @param {(record: import('./record.js').Record) => string} format
 * @returns {ExternalObject}
 */
export function recordObject(record, format){
    const object = hostObject({
        typeName: 'Record',
        members: {
            StringData: {
                get: ([field])=>getString(record, integer(field)) ?? '',
                put: (value, [field])=>{
                    setString(record, integer(field), text(value));
                },
            },
            IntegerData: {
                get: ([field])=>getInteger(record, integer(field)),
                put: (value, [field])=>{
                    setInteger(record, integer(field), integer(value));
                },
            },
            FieldCount: { get: ()=>fieldCount(record) },
            IsNull: { get: ([field])=>isNull(record, integer(field)) },
            DataSize: { get: ([field])=>dataSize(record, integer(field)) },
            ClearData: { call: ()=>{
                clearRecord(record);
            } },
            FormatText: { call: ()=>format(record) },
        },
    });
    records.set(object, record);
    return object;
}

/**
 * The record a Record object stands for, or null for anything else.
 *
 * @param {unknown} value @returns {import('./record.js').Record | null}
 */
export const recordOf = value=>(value && typeof value === 'object'
    ? records.get(value) ?? null : null);

/**
 * A View over an open query.
 *
 * @param {any} view @param {(record: import('./record.js').Record) => string} format
 * @returns {ExternalObject}
 */
function viewObject(view, format){
    return hostObject({
        typeName: 'View',
        members: {
            Execute: { call: ([parameters])=>{
                if (view.execute(recordOf(parameters)) !== ERROR_SUCCESS)
                {
                    throw failed();
                }
            } },
            Fetch: { call: ()=>{
                const record = view.fetch();
                // Past the last row a script is handed Nothing, not an error.
                return record ? recordObject(record, format) : null;
            } },
            Modify: { call: ([mode, record])=>{
                const target = recordOf(record);
                if (!target || view.modify(integer(mode), target) !== ERROR_SUCCESS)
                {
                    throw failed();
                }
            } },
            Close: { call: ()=>{
                view.close();
            } },
            ColumnInfo: { get: ([kind])=>{
                const which = integer(kind);
                if (which !== 0 && which !== 1)
                {
                    throw failed();
                }
                return recordObject(columnInfo(view.columns, null, which === 0 ? 'names'
                    : 'types'), format);
            } },
        },
    });
}

/**
 * A Database object over a database the engine has open.
 *
 * @param {import('./database.js').Database} db
 * @param {(record: import('./record.js').Record) => string} format
 * @returns {ExternalObject}
 */
function databaseObject(db, format){
    return hostObject({
        typeName: 'Database',
        members: {
            OpenView: { call: ([query])=>{
                const result = openView(db, text(query));
                if ('error' in result)
                {
                    throw failed();
                }
                return viewObject(result.view, format);
            } },
            // A session's database is never written; a commit of it does nothing.
            Commit: { call: ()=>undefined },
            DatabaseState: { get: ()=>(db.readOnly ? 0 : 1) },
            TablePersistent: { get: ([table])=>{
                const found = db.table(text(table));
                return found ? (found.temporary ? 0 : 1) : 3;
            } },
        },
    });
}

/**
 * @typedef {Object} AutomationHost
 * @property {(name: string) => string} property  A property as the action may read it.
 * @property {(name: string, value: string) => void} setProperty
 * @property {(action: string) => Promise<number>} doAction
 * @property {(table: string) => Promise<number>} sequence
 * @property {(kind: number, record: import('./record.js').Record) => Promise<number> | number}
 *     message
 * @property {ExternalObject} installer
 */

/**
 * The Session object of one installation, for a script custom action.
 *
 * @param {Engine} engine @param {AutomationHost} host
 * @returns {ExternalObject}
 */
export function sessionObject(engine, host){
    const { session } = engine;
    /** @param {import('./record.js').Record} record */
    const format = record=>session.format(record);
    /** @param {unknown} name */
    const feature = name=>{
        const found = session.features.get(text(name));
        if (!found)
        {
            throw failed();
        }
        return found;
    };
    /** @param {unknown} name */
    const component = name=>{
        const found = session.components.get(text(name));
        if (!found)
        {
            throw failed();
        }
        return found;
    };
    /** @param {unknown} name */
    const folder = name=>{
        const found = session.folders.get(text(name));
        if (!found)
        {
            throw failed();
        }
        return found;
    };
    return hostObject({
        typeName: 'Session',
        members: {
            Property: {
                get: ([name])=>host.property(text(name)),
                put: (value, [name])=>{
                    host.setProperty(text(name), text(value));
                },
            },
            Installer: { get: ()=>host.installer },
            Database: { get: ()=>databaseObject(session.active, format) },
            Language: { get: ()=>Number(session.getProperty('ProductLanguage')) || 0 },
            Mode: {
                get: ([flag])=>{
                    const name = /** @type {Record<number, string>} */ (RUN_MODES)[integer(flag)];
                    return Boolean(name
                        && /** @type {Record<string, boolean>} */ (session.mode)[name]);
                },
                put: (value, [flag])=>{
                    const name = /** @type {Record<number, string>} */ (RUN_MODES)[integer(flag)];
                    if (name !== 'rebootAtEnd' && name !== 'rebootNow')
                    {
                        throw failed();
                    }
                    /** @type {Record<string, boolean>} */ (session.mode)[name] = Boolean(value);
                },
            },
            SourcePath: { get: ([name])=>session.sourcePath(folder(name).key) },
            TargetPath: {
                get: ([name])=>folder(name).target ?? '',
                put: (value, [name])=>{
                    session.setTargetPath(folder(name).key, text(value));
                },
            },
            DoAction: { call: async([action])=>
                DO_ACTION_STATUS.get(await host.doAction(text(action))) ?? 3 },
            Sequence: { call: async([table])=>
                DO_ACTION_STATUS.get(await host.sequence(text(table))) ?? 3 },
            EvaluateCondition: { call: ([condition])=>{
                const answer = session.evaluate(text(condition));
                return answer === MSICONDITION.TRUE ? 1 : answer === MSICONDITION.FALSE ? 0
                    : answer === MSICONDITION.NONE ? 2 : 3;
            } },
            FormatRecord: { call: ([record])=>{
                const target = recordOf(record);
                if (!target)
                {
                    throw new ExternalError(DISP_E_TYPEMISMATCH);
                }
                return format(target);
            } },
            Message: { call: async([kind, record])=>{
                const target = recordOf(record);
                if (!target)
                {
                    throw new ExternalError(DISP_E_TYPEMISMATCH);
                }
                return host.message(integer(kind) | 0, target);
            } },
            FeatureCurrentState: { get: ([name])=>feature(name).installed },
            FeatureRequestState: {
                get: ([name])=>feature(name).action,
                put: (value, [name])=>{
                    feature(name).request = integer(value);
                    session.settleStates();
                },
            },
            FeatureValidStates: { get: ([name])=>{
                feature(name);
                // Local, absent and from source, as a feature that allows each.
                return (1 << INSTALLSTATE.LOCAL) | (1 << INSTALLSTATE.ABSENT)
                    | (1 << INSTALLSTATE.SOURCE);
            } },
            ComponentCurrentState: { get: ([name])=>component(name).installed },
            ComponentRequestState: {
                get: ([name])=>component(name).action,
                put: (value, [name])=>{
                    component(name).action = integer(value);
                },
            },
            SetInstallLevel: { call: ([level])=>{
                session.setProperty('INSTALLLEVEL', String(integer(level)));
                session.settleStates();
            } },
        },
    });
}

/**
 * @typedef {Object} InstallerHost
 * @property {import('../kernel32/versions.js').WindowsVersion} windows
 * @property {ReturnType<typeof import('./registration.js').createRegistration>} registration
 * @property {(name: string) => string | null} environment
 * @property {(path: string) => Promise<string | null>} fileVersion
 * @property {(path: string) => number | null} fileSize
 * @property {(record: import('./record.js').Record) => string} format
 */

/**
 * The Installer object: records made, the installer's version, what the
 * machine records of its products, and a file's version and size.
 *
 * @param {InstallerHost} host
 * @returns {ExternalObject}
 */
export function installerObject(host){
    const version = installerVersion(host.windows).join('.');
    return hostObject({
        typeName: 'Installer',
        members: {
            CreateRecord: { call: ([count])=>recordObject(createRecord(integer(count)),
                host.format) },
            Version: { get: ()=>version },
            ProductState: { get: ([code])=>host.registration.productState(text(code)) },
            ProductInfo: { get: ([code, attribute])=>{
                const answer = host.registration.productInfo(text(code), text(attribute));
                if ('error' in answer)
                {
                    throw failed();
                }
                return answer.value;
            } },
            Products: { get: ()=>stringList(host.registration.products()) },
            RelatedProducts: { get: ([upgrade])=>stringList(host.registration
                .relatedProducts(text(upgrade))) },
            ComponentPath: { get: ([product, id])=>host.registration
                .componentPath(text(product), text(id)) ?? '' },
            Environment: { get: ([name])=>host.environment(text(name)) ?? '' },
            FileVersion: { call: async([path])=>await host.fileVersion(text(path)) ?? '' },
            FileSize: { call: ([path])=>{
                const size = host.fileSize(text(path));
                if (size === null)
                {
                    throw failed();
                }
                return size;
            } },
        },
    });
}

/**
 * A StringList: an indexed, countable and enumerable list of strings.
 *
 * @param {string[]} items @returns {ExternalObject}
 */
function stringList(items){
    return hostObject({
        typeName: 'StringList',
        members: {
            Item: { get: ([index])=>{
                const at = integer(index);
                if (at < 0 || at >= items.length)
                {
                    throw failed();
                }
                return items[at];
            } },
            Count: { get: ()=>items.length },
        },
        value: { get: ([index])=>items[integer(index)] ?? '' },
        items: ()=>items,
    });
}

