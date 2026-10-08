/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One engine's world: its prototypes and global object, the conversions of
 * ECMA-262 3rd edition clause 9, its errors, and how anything callable is
 * called.
 *
 * A conversion that may run script -- an object's `valueOf` or `toString`,
 * an external object's default member -- is a generator, delegated to with
 * `yield*`, so that the script it runs can wait on a guest object. The
 * conversions of a primitive never run script and are plain functions; the
 * interpreter takes those first and reaches for the generator only for an
 * object.
 */

import { isThenable } from '../script/drive.js';
import {
    DEFAULT_MEMBER, DISP_E_BADPARAMCOUNT, DISP_E_MEMBERNOTFOUND, DISP_E_PARAMNOTFOUND,
    DISP_E_TYPEMISMATCH, DISP_E_UNKNOWNNAME, ExternalError, ExternalObject,
} from '../script/external.js';
import { ForeignValue, NOTHING, oleDateToWallTime } from '../script/values.js';
import { VT_DATE, VT_ERROR } from '../oleaut32/vartypes.js';
import { MESSAGES, errorNumber } from './errors.js';
import {
    DONTDELETE, DONTENUM, JSArray, JSFunction, JSObject, Property, READONLY, ScriptThrow,
    StringObject, isSteps,
} from './objects.js';

/**
 * What a realm needs of the interpreter: running a script function, and
 * making one from its node.
 *
 * @typedef {Object} ScriptRunner
 * @property {(fn: JSFunction, thisValue: any, args: any[]) => Generator<unknown, any, unknown>}
 *     callScript
 * @property {(fn: JSFunction, args: any[]) => Generator<unknown, any, unknown>} constructScript
 * @property {(text: string, ctx: any) => Generator<unknown, any, unknown>} evaluate
 *     `eval` of a text: in the calling code's scope when `ctx` is its
 *     context, in the global scope when null.
 * @property {(params: string, body: string) => JSFunction} compileFunction
 */

/**
 * The engine version a script can ask about, with ScriptEngine*Version and
 * `@_jscript_version`.
 *
 * @typedef {{ major: number, minor: number, build: number }} EngineVersion
 */

/**
 * @typedef {Object} RealmOptions
 * @property {EngineVersion} version
 * @property {() => number} now  Milliseconds since 1970, UTC: the machine's clock.
 * @property {(utc: number) => number} localOffset
 *     Milliseconds the local time zone is ahead of UTC at that instant,
 *     daylight saving included.
 * @property {() => number} random
 * @property {(progId: string, location: string | undefined)
 *     => ExternalObject | Promise<ExternalObject>} [createObject]
 *     ActiveXObject: the class's automation object, or an ExternalError.
 * @property {(path: string, progId: string | undefined)
 *     => ExternalObject | Promise<ExternalObject>} [getObject]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @typedef {'Error' | 'EvalError' | 'RangeError' | 'ReferenceError' | 'SyntaxError'
 *     | 'TypeError' | 'URIError'} ErrorType */

/** ES3's white space and line terminators, which a numeric string may be wrapped in. */
const STRING_SPACE = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const DECIMAL = /^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;
const HEX = /^0[xX][0-9a-fA-F]+$/;

/**
 * ToNumber of a string (9.3.1): a decimal literal, a hexadecimal one, or
 * nothing at all, between white space; anything else is NaN.
 *
 * @param {string} text @returns {number}
 */
export function stringToNumber(text){
    const trimmed = text.replace(STRING_SPACE, '');
    if (trimmed === '')
    {
        return 0;
    }
    if (DECIMAL.test(trimmed))
    {
        return Number(trimmed);
    }
    if (HEX.test(trimmed))
    {
        return parseInt(trimmed.slice(2), 16);
    }
    return NaN;
}

/** @param {number} n @returns {string} ToString of a number (9.8.1). */
export const numberToString = n=>String(n);

/** @param {number} n @returns {number} ToInteger (9.4). */
export function toInteger(n){
    if (Number.isNaN(n))
    {
        return 0;
    }
    if (n === 0 || !Number.isFinite(n))
    {
        return n;
    }
    return Math.trunc(n);
}

/** @param {any} value @returns {boolean} ToBoolean (9.2). */
export function toBoolean(value){
    switch (typeof value)
    {
        case 'boolean': return value;
        case 'number': return value !== 0 && !Number.isNaN(value);
        case 'string': return value.length > 0;
        case 'undefined': return false;
        default: return value !== null;
    }
}

/** @param {any} value @returns {boolean} whether it is a primitive */
export const isPrimitive = value=>value === null || typeof value !== 'object';

export class Realm
{
    /** @param {RealmOptions} options */
    constructor(options){
        this.options = options;
        const objectPrototype = new JSObject(null, 'Object');
        this.objectPrototype = objectPrototype;
        const functionPrototype = new JSFunction(objectPrototype);
        functionPrototype.native = ()=>undefined;
        functionPrototype.nativeName = '';
        this.functionPrototype = functionPrototype;
        this.arrayPrototype = new JSArray(objectPrototype);
        this.stringPrototype = new StringObject(objectPrototype, '');
        this.numberPrototype = new JSObject(objectPrototype, 'Number');
        this.numberPrototype.value = 0;
        this.booleanPrototype = new JSObject(objectPrototype, 'Boolean');
        this.booleanPrototype.value = false;
        this.datePrototype = new JSObject(objectPrototype, 'Object');
        this.regexpPrototype = new JSObject(objectPrototype, 'Object');
        this.errorPrototype = new JSObject(objectPrototype, 'Error');
        /** @type {Map<string, JSObject>} each error type's prototype */
        this.errorPrototypes = new Map([['Error', this.errorPrototype]]);
        this.global = new JSObject(objectPrototype, 'Object');
        /** @type {ScriptRunner | null} */
        this.runner = null;
        /** @type {JSFunction | null} */
        this.evalFunction = null;
        /** Where the statement running now is: an error says it happened there. */
        /** @type {import('./parser.js').SourceText | null} */
        this.source = null;
        this.offset = 0;
        /**
         * Makes a RegExp object: the built-ins install it, and a regular
         * expression literal is made with it.
         *
         * @type {((pattern: string, flags: string) => JSObject) | null}
         */
        this.regexpFactory = null;
        /**
         * A name the scope chain does not have, asked of the host: an active
         * script's named items, found as they are first used.
         *
         * @type {((name: string) => Generator<unknown, { value: any } | null, unknown>) | null}
         */
        this.globalFallback = null;
    }

    /** @returns {ScriptRunner} */
    get run(){
        return /** @type {ScriptRunner} */ (this.runner);
    }

    /**
     * A built-in function.
     *
     * @param {string} name @param {number} length
     * @param {import('./objects.js').NativeCall} call
     * @param {import('./objects.js').NativeCall | null} [construct]
     * @returns {JSFunction}
     */
    native(name, length, call, construct = null){
        const fn = new JSFunction(this.functionPrototype);
        fn.native = call;
        fn.construct = construct;
        fn.nativeName = name;
        fn.define('length', length, READONLY | DONTENUM | DONTDELETE);
        return fn;
    }

    /**
     * Puts built-in methods on an object, hidden from for-in as all of them are.
     *
     * @param {JSObject} target
     * @param {[string, number, import('./objects.js').NativeCall][]} methods
     *     Each one's name, its `length`, and itself.
     */
    methods(target, methods){
        for (const [name, length, call] of methods)
        {
            target.define(name, this.native(name, length, call), DONTENUM);
        }
    }

    /**
     * A constructor and its prototype, linked both ways.
     *
     * @param {string} name @param {number} length @param {JSObject} prototype
     * @param {import('./objects.js').NativeCall} call
     * @param {import('./objects.js').NativeCall} construct
     * @returns {JSFunction}
     */
    defineConstructor(name, length, prototype, call, construct){
        const fn = this.native(name, length, call, construct);
        fn.define('prototype', prototype, READONLY | DONTENUM | DONTDELETE);
        prototype.define('constructor', fn, DONTENUM);
        this.global.define(name, fn, DONTENUM);
        return fn;
    }

    /** @returns {{ source: import('./parser.js').SourceText | null, offset: number }} */
    where(){
        return { source: this.source, offset: this.offset };
    }

    /**
     * An error object of a type, as JScript makes one for its own errors.
     *
     * @param {ErrorType} type @param {number} number  The signed HRESULT.
     * @param {string} description
     * @returns {JSObject}
     */
    makeError(type, number, description){
        const error = new JSObject(this.errorPrototypes.get(type) ?? this.errorPrototype, 'Error');
        error.put('number', number);
        error.put('description', description);
        error.put('message', description);
        return error;
    }

    /**
     * A JScript runtime error, ready to throw.
     *
     * @param {ErrorType} type @param {number} code @param {string} [description]
     * @returns {ScriptThrow}
     */
    error(type, code, description){
        return new ScriptThrow(this.makeError(type, errorNumber(code),
            description ?? MESSAGES[code] ?? ''), this.where());
    }

    /** @param {number} code @param {string} [description] @returns {ScriptThrow} */
    typeError(code, description){
        return this.error('TypeError', code, description);
    }

    /** @param {number} code @param {string} [description] @returns {ScriptThrow} */
    rangeError(code, description){
        return this.error('RangeError', code, description);
    }

    /**
     * What a failed call on an external object becomes: the error its
     * HRESULT means to JScript, or, for an exception the object described,
     * an Error with the object's number and description.
     *
     * @param {unknown} failure @returns {unknown} what to throw
     */
    fromExternal(failure){
        if (!(failure instanceof ExternalError))
        {
            return failure;
        }
        switch (failure.number)
        {
            case DISP_E_UNKNOWNNAME:
            case DISP_E_MEMBERNOTFOUND:
                return this.typeError(438);
            case DISP_E_TYPEMISMATCH:
                return this.typeError(13);
            case DISP_E_BADPARAMCOUNT:
                return this.error('Error', 450);
            case DISP_E_PARAMNOTFOUND:
                return this.error('Error', 449);
            default:
                return new ScriptThrow(this.makeError('Error', failure.number,
                    failure.description), this.where());
        }
    }

    /**
     * Waits on what an external object answered, its failure turned into a
     * JScript error at the point the script made the call.
     *
     * @param {() => any} operation
     * @returns {Generator<unknown, any, unknown>}
     */
    *external(operation){
        try
        {
            let answer = operation();
            if (isThenable(answer))
            {
                answer = yield answer;
            }
            // An object reference to nothing is null to JScript, which has
            // no Nothing of its own.
            return answer === NOTHING ? null : answer;
        }
        catch (e){
            throw this.fromExternal(e);
        }
    }

    /**
     * typeof (11.4.3), with JScript's two more answers: "date" for an
     * automation date and "unknown" for any other VARIANT it has no type for.
     *
     * @param {any} value @returns {string}
     */
    typeOf(value){
        switch (typeof value)
        {
            case 'undefined': return 'undefined';
            case 'boolean': return 'boolean';
            case 'number': return 'number';
            case 'string': return 'string';
            default:
                if (value === null)
                {
                    return 'object';
                }
                if (value instanceof JSObject)
                {
                    return value.callable ? 'function' : 'object';
                }
                if (value instanceof ForeignValue)
                {
                    return value.vt === VT_DATE ? 'date' : 'unknown';
                }
                return 'object';
        }
    }

    /**
     * ToObject (9.9).
     *
     * @param {any} value @param {string} [what]  The expression, for the message.
     * @returns {JSObject | ExternalObject}
     */
    toObject(value, what){
        switch (typeof value)
        {
            case 'boolean':
            {
                const object = new JSObject(this.booleanPrototype, 'Boolean');
                object.value = value;
                return object;
            }
            case 'number':
            {
                const object = new JSObject(this.numberPrototype, 'Number');
                object.value = value;
                return object;
            }
            case 'string':
                return new StringObject(this.stringPrototype, value);
            case 'object':
                if (value instanceof JSObject || value instanceof ExternalObject)
                {
                    return value;
                }
                break;
            default:
                break;
        }
        throw this.typeError(5007, what === undefined
            ? undefined : `'${what}' is null or not an object`);
    }

    /**
     * ToPrimitive (9.1): an object's [[DefaultValue]], an external object's
     * default member, an automation date as text or as its number.
     *
     * @param {any} value @param {'number' | 'string' | undefined} [hint]
     * @returns {Generator<unknown, any, unknown>}
     */
    *toPrimitive(value, hint){
        if (isPrimitive(value))
        {
            return value;
        }
        if (value instanceof JSObject)
        {
            return yield* this.defaultValue(value,
                hint ?? (value.cls === 'Date' ? 'string' : 'number'));
        }
        if (value instanceof ExternalObject)
        {
            const answer = yield* this.external(()=>value.get(DEFAULT_MEMBER, []));
            if (!isPrimitive(answer))
            {
                return yield* this.toPrimitive(answer, hint);
            }
            return answer;
        }
        if (value instanceof ForeignValue)
        {
            return this.foreignPrimitive(value, hint);
        }
        throw this.typeError(5007);
    }

    /**
     * A VARIANT JScript has no type for, as a primitive: a date reads as
     * its text or as its automation number, an error code as its number,
     * anything else is a type mismatch.
     *
     * @param {ForeignValue} value @param {'number' | 'string' | undefined} hint
     * @returns {string | number}
     */
    foreignPrimitive(value, hint){
        if (value.vt === VT_DATE)
        {
            return hint === 'number' ? value.value : formatVariantDate(value.value);
        }
        if (value.vt === VT_ERROR)
        {
            return value.value;
        }
        throw this.typeError(13);
    }

    /**
     * [[DefaultValue]] (8.6.2.6).
     *
     * @param {JSObject} object @param {'number' | 'string'} hint
     * @returns {Generator<unknown, any, unknown>}
     */
    *defaultValue(object, hint){
        const order = hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString'];
        for (const name of order)
        {
            const method = object.get(name);
            if (method instanceof JSFunction)
            {
                const answer = yield* this.call(method, object, []);
                if (isPrimitive(answer) || answer instanceof ForeignValue)
                {
                    return answer instanceof ForeignValue
                        ? this.foreignPrimitive(answer, hint) : answer;
                }
            }
        }
        throw this.typeError(5007);
    }

    /** @param {any} value @returns {Generator<unknown, number, unknown>} */
    *toNumber(value){
        switch (typeof value)
        {
            case 'number': return value;
            case 'string': return stringToNumber(value);
            case 'boolean': return value ? 1 : 0;
            case 'undefined': return NaN;
            default:
                if (value === null)
                {
                    return 0;
                }
                return this.primitiveNumber(yield* this.toPrimitive(value, 'number'));
        }
    }

    /** @param {any} value @returns {number} ToNumber of a primitive */
    primitiveNumber(value){
        switch (typeof value)
        {
            case 'number': return value;
            case 'string': return stringToNumber(value);
            case 'boolean': return value ? 1 : 0;
            case 'undefined': return NaN;
            default: return 0;
        }
    }

    /** @param {any} value @returns {Generator<unknown, string, unknown>} */
    *toString(value){
        switch (typeof value)
        {
            case 'string': return value;
            case 'number': return numberToString(value);
            case 'boolean': return value ? 'true' : 'false';
            case 'undefined': return 'undefined';
            default:
                if (value === null)
                {
                    return 'null';
                }
                return this.primitiveString(yield* this.toPrimitive(value, 'string'));
        }
    }

    /** @param {any} value @returns {string} ToString of a primitive */
    primitiveString(value){
        switch (typeof value)
        {
            case 'string': return value;
            case 'number': return numberToString(value);
            case 'boolean': return value ? 'true' : 'false';
            case 'undefined': return 'undefined';
            default: return 'null';
        }
    }

    /**
     * Calls anything callable: a function, or an external object, whose
     * call is its default member's.
     *
     * @param {any} fn @param {any} thisValue @param {any[]} args
     * @returns {Generator<unknown, any, unknown>}
     */
    *call(fn, thisValue, args){
        if (fn instanceof JSFunction)
        {
            if (fn.native !== null)
            {
                const answer = fn.native(thisValue, args, fn);
                return isSteps(answer) ? yield* answer : answer;
            }
            return yield* this.run.callScript(fn, thisValue === null || thisValue === undefined
                || !isPrimitive(thisValue) ? thisValue : this.toObject(thisValue), args);
        }
        if (fn instanceof ExternalObject)
        {
            return yield* this.external(()=>fn.call(DEFAULT_MEMBER, args));
        }
        throw this.typeError(5002);
    }

    /**
     * `new` (11.2.2).
     *
     * @param {any} fn @param {any[]} args
     * @returns {Generator<unknown, any, unknown>}
     */
    *construct(fn, args){
        if (fn instanceof JSFunction)
        {
            if (fn.native !== null)
            {
                if (fn.construct === null)
                {
                    throw this.typeError(445);
                }
                const answer = fn.construct(undefined, args, fn);
                return isSteps(answer) ? yield* answer : answer;
            }
            return yield* this.run.constructScript(fn, args);
        }
        throw this.typeError(fn instanceof ExternalObject ? 445 : 5002);
    }

    /**
     * A new Array holding these values.
     *
     * @param {any[]} values @returns {JSArray}
     */
    newArray(values = []){
        const array = new JSArray(this.arrayPrototype);
        for (let i = 0; i < values.length; i++)
        {
            array.props.set(String(i), new Property(values[i], 0));
        }
        array.length = values.length;
        return array;
    }

    /** @returns {JSObject} a new plain object */
    newObject(){
        return new JSObject(this.objectPrototype, 'Object');
    }
}

/** @param {number} n @param {number} width */
const pad = (n, width)=>String(n).padStart(width, '0');

/**
 * An automation date as the text VariantChangeType gives it on an English
 * system: the date as M/D/YYYY, then the time with AM or PM unless it is
 * midnight; a date of 0 is a time alone.
 *
 * @param {number} oleDate @returns {string}
 */
export function formatVariantDate(oleDate){
    const wall = new Date(oleDateToWallTime(oleDate));
    if (Number.isNaN(wall.getTime()))
    {
        return '';
    }
    const date = `${wall.getUTCMonth() + 1}/${wall.getUTCDate()}/${wall.getUTCFullYear()}`;
    const hours = wall.getUTCHours();
    const minutes = wall.getUTCMinutes();
    const seconds = wall.getUTCSeconds();
    const time = `${hours % 12 === 0 ? 12 : hours % 12}:${pad(minutes, 2)}:${pad(seconds, 2)} `
        + (hours < 12 ? 'AM' : 'PM');
    const dayPart = Math.trunc(oleDate);
    if (dayPart === 0)
    {
        return time;
    }
    return hours === 0 && minutes === 0 && seconds === 0 ? date : `${date} ${time}`;
}
