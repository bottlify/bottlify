/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An event of a process in a worker of its own, as the run's bus hears it.
 *
 * The page subscribes on the run's bus, on the thread that started the
 * process, so what happens to the process -- a library it loaded, a call it
 * made that is missing, a failure it cannot see -- has to cross the link as
 * values (`codec.js`). A payload is mostly values already; what is not is
 * turned into what a subscriber reads of it: an error into its name, message,
 * stack and own properties, which `eventFrom` makes an error again, a map
 * into its entries, a set into its members. A function, a symbol or an object
 * inside itself says nothing a subscriber could use and is left out.
 */

/** The key an error is marked with. Not a property a payload of ours has. */
const ERROR = '$error';

/** How deep a payload is followed: past it, a branch is left out. */
const DEPTH = 32;

/** The longest view other than bytes kept as numbers. */
const VIEW_LIMIT = 4096;

/**
 * @param {any} value @param {Set<object>} seen @param {number} depth
 * @returns {any}
 */
const plainOf = (value, seen, depth)=>{
    if (value === null || value === undefined || typeof value === 'boolean'
        || typeof value === 'number' || typeof value === 'string')
    {
        return value;
    }
    if (typeof value === 'bigint')
    {
        return Number(value);
    }
    if (typeof value !== 'object' || depth > DEPTH || seen.has(value))
    {
        return undefined;
    }
    if (value instanceof Uint8Array)
    {
        return value;
    }
    if (ArrayBuffer.isView(value))
    {
        const numbers = /** @type {any} */ (value);
        return typeof numbers.length === 'number' && numbers.length <= VIEW_LIMIT
            ? Array.from(numbers, Number) : undefined;
    }
    seen.add(value);
    try
    {
        if (Array.isArray(value))
        {
            return value.map(item=>plainOf(item, seen, depth + 1) ?? null);
        }
        if (value instanceof Map)
        {
            return [...value].map(entry=>plainOf(entry, seen, depth + 1) ?? null);
        }
        if (value instanceof Set)
        {
            return [...value].map(item=>plainOf(item, seen, depth + 1) ?? null);
        }
        /** @type {Record<string, any>} */
        const out = {};
        if (value instanceof Error)
        {
            out[ERROR] = true;
            out.name = value.name;
            out.message = value.message;
            out.stack = value.stack ?? null;
        }
        for (const [key, item] of Object.entries(value))
        {
            const plain = plainOf(item, seen, depth + 1);
            if (plain !== undefined)
            {
                out[key] = plain;
            }
        }
        return out;
    }
    finally
    {
        seen.delete(value);
    }
};

/**
 * A payload as values that cross the link.
 *
 * @param {any} payload
 * @returns {any}
 */
export function plainEvent(payload){
    return plainOf(payload, new Set(), 0) ?? null;
}

/**
 * A payload `plainEvent` made, as the run's bus hands it to subscribers: its
 * errors errors again.
 *
 * @param {any} plain
 * @returns {any}
 */
export function eventFrom(plain){
    if (plain === null || typeof plain !== 'object' || plain instanceof Uint8Array)
    {
        return plain;
    }
    if (Array.isArray(plain))
    {
        return plain.map(eventFrom);
    }
    if (plain[ERROR] === true)
    {
        const { name, message, stack, ...rest } = plain;
        delete rest[ERROR];
        const error = new Error(message);
        error.name = name;
        if (stack !== null)
        {
            error.stack = stack;
        }
        return Object.assign(error, eventFrom(rest));
    }
    return Object.fromEntries(Object.entries(plain).map(([key, value])=>[key, eventFrom(value)]));
}
