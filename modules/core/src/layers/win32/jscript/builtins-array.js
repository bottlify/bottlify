/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Array (ECMA-262 3rd edition 15.4), as JScript 5 has it: the methods are
 * generic over any object with a length, `splice` with one argument removes
 * nothing (ES3 reads the missing count as 0), and `unshift` answers
 * undefined rather than the new length, as JScript before version 9 does.
 */

import { ExternalObject } from '../script/external.js';
import { JSArray, JSFunction, JSObject } from './objects.js';
import { toInteger } from './realm.js';
import { toUint32 } from './builtins-core.js';

/** @typedef {import('./realm.js').Realm} Realm */

/** @param {Realm} realm */
export function installArray(realm){
    const prototype = realm.arrayPrototype;

    /** @param {any[]} args @returns {JSArray} */
    const make = args=>{
        if (args.length === 1 && typeof args[0] === 'number')
        {
            const length = args[0];
            if (toUint32(length) !== length)
            {
                throw realm.rangeError(5029);
            }
            const array = realm.newArray();
            array.length = length;
            return array;
        }
        return realm.newArray(args);
    };
    realm.defineConstructor('Array', 1, prototype, (_this, args)=>make(args),
        (_this, args)=>make(args));

    /** @param {any} self @returns {JSObject} */
    const thisObject = self=>{
        const object = self === undefined || self === null ? realm.global : realm.toObject(self);
        if (object instanceof ExternalObject)
        {
            throw realm.typeError(5014);
        }
        return object;
    };
    /** @param {JSObject} object @returns {Generator<unknown, number, unknown>} */
    const lengthOf = function*(object){
        if (object instanceof JSArray)
        {
            return object.length;
        }
        return toUint32(yield* realm.toNumber(object.get('length')));
    };
    /** @param {JSObject} object @param {number} length */
    const setLength = (object, length)=>{
        if (object instanceof JSArray)
        {
            object.setLength(length);
        }
        else
        {
            object.put('length', length);
        }
    };
    /**
     * A relative index: from the end when negative, clamped to the length.
     *
     * @param {any} value @param {number} length @param {number} fallback
     * @returns {Generator<unknown, number, unknown>}
     */
    const relative = function*(value, length, fallback){
        if (value === undefined)
        {
            return fallback;
        }
        const n = toInteger(yield* realm.toNumber(value));
        return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
    };
    /**
     * @param {JSObject} object @param {string} separator @param {boolean} locale
     * @returns {Generator<unknown, string, unknown>}
     */
    const join = function*(object, separator, locale){
        const length = yield* lengthOf(object);
        const parts = new Array(length);
        for (let i = 0; i < length; i++)
        {
            const element = object.get(String(i));
            if (element === undefined || element === null)
            {
                parts[i] = '';
            }
            else if (locale)
            {
                const wrapped = realm.toObject(element);
                const method = wrapped instanceof JSObject
                    ? wrapped.get('toLocaleString') : undefined;
                parts[i] = yield* realm.toString(yield* realm.call(method, wrapped, []));
            }
            else
            {
                parts[i] = yield* realm.toString(element);
            }
        }
        return parts.join(separator);
    };

    realm.methods(prototype, [
        ['toString', 0, self=>{
            if (!(self instanceof JSArray))
            {
                throw realm.typeError(5014);
            }
            return join(self, ',', false);
        }],
        ['toLocaleString', 0, self=>{
            if (!(self instanceof JSArray))
            {
                throw realm.typeError(5014);
            }
            return join(self, ',', true);
        }],
        ['join', 1, function*(self, args){
            const object = thisObject(self);
            const separator = args[0] === undefined ? ',' : yield* realm.toString(args[0]);
            return yield* join(object, separator, false);
        }],
        ['concat', 1, (self, args)=>{
            const object = thisObject(self);
            const result = realm.newArray();
            let n = 0;
            for (const item of [object, ...args])
            {
                if (item instanceof JSArray)
                {
                    for (let k = 0; k < item.length; k++)
                    {
                        const own = item.lookup(String(k));
                        if (own !== undefined)
                        {
                            result.put(String(n), own.value);
                        }
                        n++;
                    }
                }
                else
                {
                    result.put(String(n), item);
                    n++;
                }
            }
            result.length = n;
            return result;
        }],
        ['pop', 0, function*(self){
            const object = thisObject(self);
            const length = yield* lengthOf(object);
            if (length === 0)
            {
                setLength(object, 0);
                return undefined;
            }
            const key = String(length - 1);
            const element = object.get(key);
            object.delete(key);
            setLength(object, length - 1);
            return element;
        }],
        ['push', 1, function*(self, args){
            const object = thisObject(self);
            let length = yield* lengthOf(object);
            for (const item of args)
            {
                object.put(String(length), item);
                length++;
            }
            setLength(object, length);
            return length;
        }],
        ['reverse', 0, function*(self){
            const object = thisObject(self);
            const length = yield* lengthOf(object);
            for (let lower = 0, upper = length - 1; lower < upper; lower++, upper--)
            {
                swap(object, String(lower), String(upper));
            }
            return object;
        }],
        ['shift', 0, function*(self){
            const object = thisObject(self);
            const length = yield* lengthOf(object);
            if (length === 0)
            {
                setLength(object, 0);
                return undefined;
            }
            const first = object.get('0');
            for (let k = 1; k < length; k++)
            {
                move(object, String(k), String(k - 1));
            }
            object.delete(String(length - 1));
            setLength(object, length - 1);
            return first;
        }],
        ['unshift', 1, function*(self, args){
            const object = thisObject(self);
            const length = yield* lengthOf(object);
            for (let k = length; k > 0; k--)
            {
                move(object, String(k - 1), String(k + args.length - 1));
            }
            args.forEach((item, j)=>object.put(String(j), item));
            setLength(object, length + args.length);
            return undefined;
        }],
        ['slice', 2, function*(self, args){
            const object = thisObject(self);
            const length = yield* lengthOf(object);
            const start = yield* relative(args[0], length, 0);
            const end = yield* relative(args[1], length, length);
            const result = realm.newArray();
            let n = 0;
            for (let k = start; k < end; k++, n++)
            {
                const own = object.lookup(String(k));
                if (own !== undefined)
                {
                    result.put(String(n), own.value);
                }
            }
            result.length = Math.max(n, 0);
            return result;
        }],
        ['splice', 2, function*(self, args){
            const object = thisObject(self);
            const length = yield* lengthOf(object);
            const start = yield* relative(args[0], length, 0);
            const count = Math.min(Math.max(toInteger(yield* realm.toNumber(args[1])), 0),
                length - start);
            const items = args.slice(2);
            const removed = realm.newArray();
            for (let k = 0; k < count; k++)
            {
                const own = object.lookup(String(start + k));
                if (own !== undefined)
                {
                    removed.put(String(k), own.value);
                }
            }
            removed.length = count;
            if (items.length < count)
            {
                for (let k = start; k < length - count; k++)
                {
                    move(object, String(k + count), String(k + items.length));
                }
                for (let k = length; k > length - count + items.length; k--)
                {
                    object.delete(String(k - 1));
                }
            }
            else if (items.length > count)
            {
                for (let k = length - count; k > start; k--)
                {
                    move(object, String(k + count - 1), String(k + items.length - 1));
                }
            }
            items.forEach((item, j)=>object.put(String(start + j), item));
            setLength(object, length - count + items.length);
            return removed;
        }],
        ['sort', 1, function*(self, args){
            const object = thisObject(self);
            const compare = args[0];
            if (compare !== undefined && !(compare instanceof JSFunction))
            {
                throw realm.typeError(5002);
            }
            const length = yield* lengthOf(object);
            const values = [];
            let undefineds = 0;
            for (let k = 0; k < length; k++)
            {
                const own = object.lookup(String(k));
                if (own === undefined)
                {
                    continue;
                }
                if (own.value === undefined)
                {
                    undefineds++;
                }
                else
                {
                    values.push(own.value);
                }
            }
            /** @param {any} x @param {any} y @returns {Generator<unknown, number, unknown>} */
            const order = function*(x, y){
                if (compare !== undefined)
                {
                    return yield* realm.toNumber(yield* realm.call(compare, undefined, [x, y]));
                }
                const a = yield* realm.toString(x);
                const b = yield* realm.toString(y);
                return a < b ? -1 : a > b ? 1 : 0;
            };
            const sorted = yield* mergeSort(values, order);
            let k = 0;
            for (const value of sorted)
            {
                object.put(String(k++), value);
            }
            for (let u = 0; u < undefineds; u++)
            {
                object.put(String(k++), undefined);
            }
            for (; k < length; k++)
            {
                object.delete(String(k));
            }
            return object;
        }],
    ]);
}

/** @param {JSObject} object @param {string} from @param {string} to */
function move(object, from, to){
    const own = object.lookup(from);
    if (own !== undefined)
    {
        object.put(to, own.value);
    }
    else
    {
        object.delete(to);
    }
}

/**
 * Exchanges two elements, a missing one included. The values are taken
 * first: a property found is the object's own record, which the first
 * write changes.
 *
 * @param {JSObject} object @param {string} a @param {string} b
 */
function swap(object, a, b){
    const first = object.lookup(a);
    const second = object.lookup(b);
    const firstValue = first?.value;
    const secondValue = second?.value;
    if (second !== undefined)
    {
        object.put(a, secondValue);
    }
    else
    {
        object.delete(a);
    }
    if (first !== undefined)
    {
        object.put(b, firstValue);
    }
    else
    {
        object.delete(b);
    }
}

/**
 * A stable merge sort whose comparison may run script.
 *
 * @param {any[]} values
 * @param {(x: any, y: any) => Generator<unknown, number, unknown>} order
 * @returns {Generator<unknown, any[], unknown>}
 */
function* mergeSort(values, order){
    if (values.length < 2)
    {
        return values;
    }
    const middle = values.length >> 1;
    const left = yield* mergeSort(values.slice(0, middle), order);
    const right = yield* mergeSort(values.slice(middle), order);
    const merged = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length)
    {
        // Ties keep their order: only a right element strictly before a
        // left one goes first.
        if ((yield* order(right[j], left[i])) < 0)
        {
            merged.push(right[j++]);
        }
        else
        {
            merged.push(left[i++]);
        }
    }
    while (i < left.length)
    {
        merged.push(left[i++]);
    }
    while (j < right.length)
    {
        merged.push(right[j++]);
    }
    return merged;
}
