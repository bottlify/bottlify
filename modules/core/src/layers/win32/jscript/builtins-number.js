/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Number and Math (ECMA-262 3rd edition 15.7 and 15.8).
 *
 * A number's text is the host's: ES3's ToString of a number (9.8.1) and
 * the three formatting methods are specified exactly, and the host follows
 * the same specification. toLocaleString is an English system's: digits
 * grouped by thousands with commas and two decimals, as JScript asks the
 * system to format a number.
 */

import { DONTDELETE, DONTENUM, JSObject, READONLY } from './objects.js';
import { numberToString, toInteger } from './realm.js';

/** @typedef {import('./realm.js').Realm} Realm */

/**
 * A number as an English system's locale formats one.
 *
 * @param {number} value @returns {string}
 */
export function localeNumber(value){
    if (!Number.isFinite(value))
    {
        return numberToString(value);
    }
    const [whole, fraction] = Math.abs(value).toFixed(2).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${value < 0 ? '-' : ''}${grouped}.${fraction}`;
}

/** @param {Realm} realm */
export function installNumber(realm){
    const prototype = realm.numberPrototype;
    const constructor = realm.defineConstructor('Number', 1, prototype,
        function*(_this, args){
            return args.length === 0 ? 0 : yield* realm.toNumber(args[0]);
        },
        function*(_this, args){
            const object = new JSObject(prototype, 'Number');
            object.value = args.length === 0 ? 0 : yield* realm.toNumber(args[0]);
            return object;
        });
    const fixed = READONLY | DONTENUM | DONTDELETE;
    constructor.define('MAX_VALUE', Number.MAX_VALUE, fixed);
    constructor.define('MIN_VALUE', Number.MIN_VALUE, fixed);
    constructor.define('NaN', NaN, fixed);
    constructor.define('NEGATIVE_INFINITY', -Infinity, fixed);
    constructor.define('POSITIVE_INFINITY', Infinity, fixed);

    /** @param {any} self @returns {number} */
    const thisNumber = self=>{
        if (typeof self === 'number')
        {
            return self;
        }
        if (self instanceof JSObject && self.cls === 'Number')
        {
            return self.value;
        }
        throw realm.typeError(5001);
    };
    /**
     * @param {any} value @param {number} low @param {number} high @param {number} code
     * @returns {Generator<unknown, number, unknown>}
     */
    const digits = function*(value, low, high, code){
        const n = toInteger(yield* realm.toNumber(value));
        if (n < low || n > high)
        {
            throw realm.rangeError(code);
        }
        return n;
    };

    realm.methods(prototype, [
        ['toString', 1, function*(self, args){
            const value = thisNumber(self);
            if (args[0] === undefined)
            {
                return numberToString(value);
            }
            const radix = toInteger(yield* realm.toNumber(args[0]));
            if (radix < 2 || radix > 36)
            {
                throw realm.error('Error', 5);
            }
            return radix === 10 ? numberToString(value) : value.toString(radix);
        }],
        ['toLocaleString', 0, self=>localeNumber(thisNumber(self))],
        ['valueOf', 0, self=>thisNumber(self)],
        ['toFixed', 1, function*(self, args){
            const value = thisNumber(self);
            const count = yield* digits(args[0], 0, 20, 5026);
            return value.toFixed(count);
        }],
        ['toExponential', 1, function*(self, args){
            const value = thisNumber(self);
            if (args[0] === undefined)
            {
                return value.toExponential();
            }
            return value.toExponential(yield* digits(args[0], 0, 20, 5026));
        }],
        ['toPrecision', 1, function*(self, args){
            const value = thisNumber(self);
            if (args[0] === undefined)
            {
                return numberToString(value);
            }
            return value.toPrecision(yield* digits(args[0], 1, 21, 5027));
        }],
    ]);

    installMath(realm);
}

/** @param {Realm} realm */
function installMath(realm){
    const math = new JSObject(realm.objectPrototype, 'Math');
    realm.global.define('Math', math, DONTENUM);
    const fixed = READONLY | DONTENUM | DONTDELETE;
    for (const name of ['E', 'LN10', 'LN2', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2'])
    {
        math.define(name, /** @type {Record<string, any>} */ (Math)[name], fixed);
    }
    /** @param {(x: number) => number} f @returns {import('./objects.js').NativeCall} */
    const unary = f=>function*(_this, args){
        return f(yield* realm.toNumber(args[0]));
    };
    /** @param {(...values: number[]) => number} f @returns {import('./objects.js').NativeCall} */
    const variadic = f=>function*(_this, args){
        const values = [];
        for (const arg of args)
        {
            values.push(yield* realm.toNumber(arg));
        }
        return f(...values);
    };
    realm.methods(math, [
        ['abs', 1, unary(Math.abs)],
        ['acos', 1, unary(Math.acos)],
        ['asin', 1, unary(Math.asin)],
        ['atan', 1, unary(Math.atan)],
        ['ceil', 1, unary(Math.ceil)],
        ['cos', 1, unary(Math.cos)],
        ['exp', 1, unary(Math.exp)],
        ['floor', 1, unary(Math.floor)],
        ['log', 1, unary(Math.log)],
        ['round', 1, unary(Math.round)],
        ['sin', 1, unary(Math.sin)],
        ['sqrt', 1, unary(Math.sqrt)],
        ['tan', 1, unary(Math.tan)],
        ['atan2', 2, function*(_this, args){
            return Math.atan2(yield* realm.toNumber(args[0]), yield* realm.toNumber(args[1]));
        }],
        ['pow', 2, function*(_this, args){
            return Math.pow(yield* realm.toNumber(args[0]), yield* realm.toNumber(args[1]));
        }],
        ['max', 2, variadic(Math.max)],
        ['min', 2, variadic(Math.min)],
        ['random', 0, ()=>realm.options.random()],
    ]);
}
