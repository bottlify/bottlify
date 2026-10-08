/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The global object's own functions and values (ECMA-262 3rd edition 15.1)
 * and the Object, Function, Boolean and Error constructors (15.2, 15.3,
 * 15.6, 15.11), as JScript 5 has them.
 *
 * JScript's differences kept: an Error carries `number` and `description`
 * besides `message`, its constructor takes a number before a description,
 * and its `toString` is Object's, "[object Error]" -- the "Error: text" form
 * came with JScript 9.
 */

import { ExternalObject } from '../script/external.js';
import {
    ArgumentsObject, DONTDELETE, DONTENUM, JSArray, JSFunction, JSObject, READONLY,
} from './objects.js';
import { isPrimitive, toBoolean } from './realm.js';

/**
 * @typedef {import('./realm.js').Realm} Realm
 */

/** @param {number} n @returns {number} ToInt32 (9.5). */
export const toInt32 = n=>n | 0;

/** @param {number} n @returns {number} ToUint32 (9.6). */
export const toUint32 = n=>n >>> 0;

/**
 * The elements an apply is given (15.3.4.3): an Array's or an arguments
 * object's, read up to its length.
 *
 * @param {Realm} realm @param {any} list
 * @returns {Generator<unknown, any[], unknown>}
 */
export function* listFromArrayLike(realm, list){
    if (list === null || list === undefined)
    {
        return [];
    }
    if (!(list instanceof JSArray || list instanceof ArgumentsObject))
    {
        throw realm.typeError(5028);
    }
    const length = toUint32(yield* realm.toNumber(list.get('length')));
    const values = new Array(length);
    for (let i = 0; i < length; i++)
    {
        values[i] = list.get(String(i));
    }
    return values;
}

/** The characters escape leaves alone (B.2.1). */
const UNESCAPED = /[A-Za-z0-9@*_+\-./]/;

/** @param {string} text @returns {string} */
function escape(text){
    let out = '';
    for (let i = 0; i < text.length; i++)
    {
        const c = text.charCodeAt(i);
        if (UNESCAPED.test(text[i]))
        {
            out += text[i];
        }
        else if (c < 256)
        {
            out += `%${c.toString(16).toUpperCase().padStart(2, '0')}`;
        }
        else
        {
            out += `%u${c.toString(16).toUpperCase().padStart(4, '0')}`;
        }
    }
    return out;
}

/** @param {string} text @returns {string} */
function unescape(text){
    let out = '';
    for (let i = 0; i < text.length; i++)
    {
        if (text[i] === '%')
        {
            const long = /^u[0-9a-fA-F]{4}/.exec(text.slice(i + 1, i + 6));
            if (long)
            {
                out += String.fromCharCode(parseInt(long[0].slice(1), 16));
                i += 5;
                continue;
            }
            const short = /^[0-9a-fA-F]{2}/.exec(text.slice(i + 1, i + 3));
            if (short)
            {
                out += String.fromCharCode(parseInt(short[0], 16));
                i += 2;
                continue;
            }
        }
        out += text[i];
    }
    return out;
}

/** ES3's white space, which parseInt and parseFloat step over (15.1.2.2). */
const LEADING_SPACE = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * parseInt (15.1.2.2), reading a leading 0 as octal when no radix is given,
 * as JScript does.
 *
 * @param {string} input @param {number} radix @returns {number}
 */
export function parseInteger(input, radix){
    let text = input.replace(LEADING_SPACE, '');
    let sign = 1;
    if (text[0] === '-' || text[0] === '+')
    {
        sign = text[0] === '-' ? -1 : 1;
        text = text.slice(1);
    }
    let r = toInt32(radix);
    if (r === 0)
    {
        if (/^0[xX]/.test(text))
        {
            r = 16;
            text = text.slice(2);
        }
        else
        {
            r = text[0] === '0' ? 8 : 10;
        }
    }
    else if (r === 16 && /^0[xX]/.test(text))
    {
        text = text.slice(2);
    }
    if (r < 2 || r > 36)
    {
        return NaN;
    }
    let value = 0;
    let digits = 0;
    for (const c of text)
    {
        const digit = parseInt(c, 36);
        if (Number.isNaN(digit) || digit >= r)
        {
            break;
        }
        value = value * r + digit;
        digits++;
    }
    return digits === 0 ? NaN : sign * value;
}

/**
 * The URI functions (15.1.3), their failures JScript's own errors.
 *
 * @param {Realm} realm @param {(text: string) => string} transform @param {number} code
 * @returns {import('./objects.js').NativeCall}
 */
function uriFunction(realm, transform, code){
    return function*(_this, args){
        const text = yield* realm.toString(args[0]);
        try
        {
            return transform(text);
        }
        catch {
            throw realm.error('URIError', code);
        }
    };
}

/**
 * The text a function's toString answers: a script function's own source,
 * a built-in's name around "[native code]", each on lines of their own as
 * JScript prints them.
 *
 * @param {JSFunction} fn @returns {string}
 */
export function functionText(fn){
    if (fn.node !== null)
    {
        return fn.node.text;
    }
    return `\nfunction ${fn.nativeName}() {\n    [native code]\n}\n`;
}

/** @param {Realm} realm */
export function installCore(realm){
    const global = realm.global;
    global.define('NaN', NaN, DONTENUM | DONTDELETE);
    global.define('Infinity', Infinity, DONTENUM | DONTDELETE);
    global.define('undefined', undefined, DONTENUM | DONTDELETE);

    const evalFunction = realm.native('eval', 1, (_this, args)=>(typeof args[0] === 'string'
        ? realm.run.evaluate(args[0], null) : args[0]));
    realm.evalFunction = evalFunction;
    global.define('eval', evalFunction, DONTENUM);

    realm.methods(global, [
        ['parseInt', 2, function*(_this, args){
            const text = yield* realm.toString(args[0]);
            const radix = args[1] === undefined ? 0 : yield* realm.toNumber(args[1]);
            return parseInteger(text, Number.isNaN(radix) ? 0 : radix);
        }],
        ['parseFloat', 1, function*(_this, args){
            const text = (yield* realm.toString(args[0])).replace(LEADING_SPACE, '');
            return /^[+-]?(Infinity|\d|\.\d)/.test(text) ? parseFloat(text) : NaN;
        }],
        ['isNaN', 1, function*(_this, args){
            return Number.isNaN(yield* realm.toNumber(args[0]));
        }],
        ['isFinite', 1, function*(_this, args){
            return Number.isFinite(yield* realm.toNumber(args[0]));
        }],
        ['escape', 1, function*(_this, args){
            return escape(yield* realm.toString(args[0]));
        }],
        ['unescape', 1, function*(_this, args){
            return unescape(yield* realm.toString(args[0]));
        }],
        ['encodeURI', 1, uriFunction(realm, encodeURI, 5024)],
        ['encodeURIComponent', 1, uriFunction(realm, encodeURIComponent, 5024)],
        ['decodeURI', 1, uriFunction(realm, decodeURI, 5025)],
        ['decodeURIComponent', 1, uriFunction(realm, decodeURIComponent, 5025)],
    ]);

    installObject(realm);
    installFunction(realm);
    installBoolean(realm);
    installErrors(realm);
}

/** @param {Realm} realm */
function installObject(realm){
    const prototype = realm.objectPrototype;
    /** @param {any[]} args */
    const make = args=>{
        const value = args[0];
        return value === null || value === undefined ? realm.newObject() : realm.toObject(value);
    };
    realm.defineConstructor('Object', 1, prototype, (_this, args)=>make(args),
        (_this, args)=>make(args));

    /** @param {any} self @returns {any} `this` as an object, the global object for none */
    const thisObject = self=>(self === undefined || self === null
        ? realm.global : realm.toObject(self));

    realm.methods(prototype, [
        ['toString', 0, self=>{
            const object = thisObject(self);
            return `[object ${object instanceof JSObject ? object.cls : 'Object'}]`;
        }],
        ['toLocaleString', 0, function*(self){
            const object = thisObject(self);
            const method = object instanceof JSObject ? object.get('toString') : undefined;
            return yield* realm.call(method, object, []);
        }],
        ['valueOf', 0, self=>thisObject(self)],
        ['hasOwnProperty', 1, function*(self, args){
            const key = yield* realm.toString(args[0]);
            const object = thisObject(self);
            if (object instanceof ExternalObject)
            {
                return Boolean(yield* realm.external(()=>object.has(key)));
            }
            return object.own(key) !== undefined;
        }],
        ['isPrototypeOf', 1, (self, args)=>{
            const object = thisObject(self);
            const value = args[0];
            if (!(value instanceof JSObject))
            {
                return false;
            }
            for (let o = value.proto; o !== null; o = o.proto)
            {
                if (o === object)
                {
                    return true;
                }
            }
            return false;
        }],
        ['propertyIsEnumerable', 1, function*(self, args){
            const key = yield* realm.toString(args[0]);
            const object = thisObject(self);
            if (!(object instanceof JSObject))
            {
                return false;
            }
            const own = object.own(key);
            return own !== undefined && (own.flags & DONTENUM) === 0;
        }],
    ]);
}

/** @param {Realm} realm */
function installFunction(realm){
    const prototype = realm.functionPrototype;
    /** @param {any[]} args @returns {Generator<unknown, JSFunction, unknown>} */
    const make = function*(args){
        const texts = [];
        for (const arg of args)
        {
            texts.push(yield* realm.toString(arg));
        }
        const body = texts.length > 0 ? /** @type {string} */ (texts.pop()) : '';
        return realm.run.compileFunction(texts.join(','), body);
    };
    realm.defineConstructor('Function', 1, prototype, (_this, args)=>make(args),
        (_this, args)=>make(args));
    prototype.define('length', 0, READONLY | DONTENUM | DONTDELETE);

    /** @param {any} self @returns {any} */
    const thisFunction = self=>{
        if (!(self instanceof JSFunction) && !(self instanceof ExternalObject))
        {
            throw realm.typeError(5002);
        }
        return self;
    };
    /** @param {any} value @returns {any} what call and apply pass as `this` */
    const boundThis = value=>(value === null || value === undefined
        ? undefined : realm.toObject(value));

    realm.methods(prototype, [
        ['toString', 0, self=>{
            if (!(self instanceof JSFunction))
            {
                throw realm.typeError(5002);
            }
            return functionText(self);
        }],
        ['apply', 2, function*(self, args){
            const fn = thisFunction(self);
            const list = yield* listFromArrayLike(realm, args[1]);
            return yield* realm.call(fn, boundThis(args[0]), list);
        }],
        ['call', 1, function*(self, args){
            const fn = thisFunction(self);
            return yield* realm.call(fn, boundThis(args[0]), args.slice(1));
        }],
    ]);
}

/** @param {Realm} realm */
function installBoolean(realm){
    const prototype = realm.booleanPrototype;
    realm.defineConstructor('Boolean', 1, prototype, (_this, args)=>toBoolean(args[0]),
        (_this, args)=>{
            const object = new JSObject(prototype, 'Boolean');
            object.value = toBoolean(args[0]);
            return object;
        });
    /** @param {any} self @returns {boolean} */
    const thisBoolean = self=>{
        if (typeof self === 'boolean')
        {
            return self;
        }
        if (self instanceof JSObject && self.cls === 'Boolean')
        {
            return self.value;
        }
        throw realm.typeError(5010);
    };
    realm.methods(prototype, [
        ['toString', 0, self=>(thisBoolean(self) ? 'true' : 'false')],
        ['valueOf', 0, self=>thisBoolean(self)],
    ]);
}

/** The error constructors besides Error, each with its prototype under Error's. */
const NATIVE_ERRORS = /** @type {const} */ (['EvalError', 'RangeError', 'ReferenceError',
    'SyntaxError', 'TypeError', 'URIError']);

/** @param {Realm} realm */
function installErrors(realm){
    const errorPrototype = realm.errorPrototype;
    /**
     * new Error(number, description), or new Error(description): a first
     * argument that is a number is the number.
     *
     * @param {JSObject} prototype @param {any[]} args
     * @returns {Generator<unknown, JSObject, unknown>}
     */
    const make = function*(prototype, args){
        let number = 0;
        let description = '';
        if (args.length > 0)
        {
            const first = args[0];
            const asNumber = isPrimitive(first) && first !== undefined
                ? realm.primitiveNumber(first) : NaN;
            if (!Number.isNaN(asNumber) && typeof first !== 'string')
            {
                number = asNumber;
                if (args.length > 1)
                {
                    description = yield* realm.toString(args[1]);
                }
            }
            else
            {
                description = yield* realm.toString(first);
            }
        }
        const error = new JSObject(prototype, 'Error');
        error.put('number', number);
        error.put('description', description);
        error.put('message', description);
        return error;
    };

    /** @param {string} name @param {JSObject} prototype */
    const define = (name, prototype)=>{
        prototype.define('name', name, DONTENUM);
        prototype.define('message', '', DONTENUM);
        prototype.define('description', '', DONTENUM);
        realm.defineConstructor(name, 1, prototype, (_this, args)=>make(prototype, args),
            (_this, args)=>make(prototype, args));
    };
    define('Error', errorPrototype);
    realm.methods(errorPrototype, [
        ['toString', 0, ()=>'[object Error]'],
    ]);
    for (const name of NATIVE_ERRORS)
    {
        const prototype = new JSObject(errorPrototype, 'Error');
        realm.errorPrototypes.set(name, prototype);
        define(name, prototype);
    }
}
