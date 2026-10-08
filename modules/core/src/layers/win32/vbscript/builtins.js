/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's built-in functions, as the VBScript Language Reference lists
 * them: conversions, mathematics, the type functions, arrays, the Err
 * object, objects by ProgID, Eval and Execute, the user interface through
 * the embedder, and the vb constants. Strings are `builtins-string.js`'s,
 * dates and formatting `builtins-date.js`'s, RegExp `regexp.js`'s.
 *
 * A function takes its arguments' values -- an object's default value --
 * unless it is one that looks at the object itself (IsObject, TypeName).
 * Null goes through the functions that pass it on (Abs, Fix, Hex, Left) and
 * is error 94, "Invalid use of Null", to the ones that need a value.
 */

import { roundNumber } from '../oleaut32/varmath.js';
import {
    VT_ARRAY, VT_CY, VT_DATE, VT_DECIMAL, VT_DISPATCH, VT_I2, VT_I4, VT_R4, VT_R8, VT_UI1,
} from '../oleaut32/vartypes.js';
import { hostObject } from '../script/external.js';
import { ForeignValue } from '../script/values.js';
import { MESSAGES, SOURCE_RUNTIME, UNKNOWN_ERROR, VBRuntimeError } from './errors.js';
import {
    FunctionRef, VBArray, byte, checkedDate, convertNumber, currency, date,
    fromHost, integer, isNumeric, isObject, long, parseDouble, single, toBool, toDate, toDouble,
    toLong, toStr, typeName, vtOf,
} from './values.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./interpreter.js').Interpreter} Interpreter
 * @typedef {import('./interpreter.js').Builtin} Builtin
 * @typedef {import('./interpreter.js').CallContext} CallContext
 * @typedef {import('../script/engine.js').EngineVersion} EngineVersion
 */

/**
 * What the built-ins need of the embedder.
 *
 * @typedef {Object} BuiltinHost
 * @property {EngineVersion} version
 * @property {() => number} now  Milliseconds since 1970, UTC.
 * @property {(utc: number) => number} localOffset
 * @property {((progId: string, location: string | undefined) => Value | Promise<Value>)
 *     | undefined} createObject
 * @property {((path: string, progId: string | undefined) => Value | Promise<Value>)
 *     | undefined} getObject
 * @property {((prompt: string, buttons: number, title: string) => number | Promise<number>)
 *     | undefined} msgBox
 * @property {((prompt: string, title: string, fallback: string)
 *     => string | null | Promise<string | null>) | undefined} inputBox
 * @property {((api: string, detail: string) => void) | undefined} divergence
 */

/**
 * Adds a built-in to the table.
 *
 * @param {Interpreter} interp @param {string} name @param {number} min @param {number} max
 * @param {(args: Value[], ctx: CallContext) => any} fn
 * @param {{ steps?: boolean, raw?: boolean }} [flags]
 */
export function define(interp, name, min, max, fn, flags = {}){
    interp.builtins.set(name.toLowerCase(), { name, min, max, fn, ...flags });
}

/**
 * A constant: a built-in that takes no arguments.
 *
 * @param {Interpreter} interp @param {string} name @param {Value} value
 */
export function constant(interp, name, value){
    interp.builtins.set(name.toLowerCase(), { name, value });
}

/**
 * A number function's answer in the type of its argument, the way Fix, Int
 * and Abs keep it: Null stays Null, Empty and a Boolean are Integers, text a
 * Double.
 *
 * @param {Value} value @param {(n: number) => number} fn @returns {Value}
 */
function keepingType(value, fn){
    if (value === null)
    {
        return null;
    }
    switch (typeof value)
    {
        case 'undefined': return integer(fn(0));
        case 'boolean': return wholeOf(fn(value ? -1 : 0), VT_I2);
        case 'string': return fn(parseDouble(value));
        case 'number': return fn(value);
        default:
            break;
    }
    if (!(value instanceof ForeignValue) || (value.vt & VT_ARRAY) !== 0)
    {
        throw new VBRuntimeError(13);
    }
    const n = fn(toDouble(value));
    switch (value.vt)
    {
        case VT_I2: case VT_I4: case VT_UI1:
            return wholeOf(n, value.vt);
        case VT_R4: return single(n);
        case VT_CY: return currency(n);
        case VT_DATE: return date(checkedDate(n));
        case VT_DECIMAL: return new ForeignValue(VT_DECIMAL, n);
        default: return n;
    }
}

/**
 * A whole number in the type given, or the next wider one that holds it,
 * as an overflow of an Integer becomes a Long.
 *
 * @param {number} n @param {number} vt @returns {Value}
 */
function wholeOf(n, vt){
    if (vt === VT_UI1 && n >= 0 && n <= 255)
    {
        return byte(n);
    }
    if (vt !== VT_I4 && n >= -32768 && n <= 32767)
    {
        return integer(n);
    }
    return n >= -2147483648 && n <= 2147483647 ? long(n) : n;
}

/**
 * Hex and Oct: the bits of an Integer, a Byte or a Long -- anything else
 * rounded to a Long -- in base 16 or 8, a negative as its two's complement.
 *
 * @param {Value} value @param {number} radix @returns {Value}
 */
function radixText(value, radix){
    if (value === null)
    {
        return null;
    }
    let bits;
    if (value instanceof ForeignValue && value.vt === VT_I2)
    {
        bits = value.value & 0xffff;
    }
    else if (value instanceof ForeignValue && value.vt === VT_UI1)
    {
        bits = value.value;
    }
    else if (value === undefined)
    {
        bits = 0;
    }
    else
    {
        bits = toLong(value) >>> 0;
    }
    return bits.toString(radix).toUpperCase();
}

/** VBScript's random number generator: Rnd's 24-bit state and its sequence. */
class RandomState
{
    constructor(){
        // The seed every run starts from, so that Rnd without Randomize
        // gives the same sequence each time.
        this.seed = 0x50000;
    }

    /** @returns {number} the next number, from 0 up to 1 */
    advance(){
        this.seed = Number((BigInt(this.seed) * 1140671485n + 12820163n) & 0xffffffn);
        return this.seed / 0x1000000;
    }

    /**
     * Rnd(n): a negative number starts a sequence of its own from its bits,
     * zero repeats the last number, anything else the next one.
     *
     * @param {number | undefined} n @returns {number}
     */
    rnd(n){
        if (n !== undefined && n < 0)
        {
            const bits = new Uint32Array(new Float32Array([n]).buffer)[0];
            this.seed = (bits + (bits >>> 24)) & 0xffffff;
        }
        if (n === 0)
        {
            return this.seed / 0x1000000;
        }
        return this.advance();
    }

    /**
     * Randomize n: the middle of the state taken from the high half of the
     * number's double.
     *
     * @param {number} n
     */
    randomize(n){
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, n, true);
        const high = view.getUint32(4, true);
        const mixed = ((high >>> 16) ^ high) & 0xffff;
        this.seed = ((this.seed & 0xff) | (mixed << 8)) & 0xffffff;
    }
}

/** A message box's answers: what an embedder's hook may answer. */
export const VB_OK = 1;

/**
 * The Err object: the last runtime error's number, description and source,
 * Raise and Clear.
 *
 * @param {Interpreter} interp
 */
function errObject(interp){
    const err = interp.err;
    /** @param {'description' | 'source' | 'helpFile'} field */
    const text = field=>({
        get: ()=>err[field],
        put: (/** @type {Value} */ value)=>{
            err[field] = toStr(fromHost(value));
        },
    });
    return hostObject({
        typeName: 'ErrObject',
        value: { get: ()=>err.number },
        members: {
            Number: { get: ()=>err.number,
                put: value=>{
                    err.number = toLong(fromHost(value));
                } },
            Description: text('description'),
            Source: text('source'),
            HelpFile: text('helpFile'),
            HelpContext: { get: ()=>err.helpContext,
                put: value=>{
                    err.helpContext = toLong(fromHost(value));
                } },
            Raise: { call: ([number, source, description, helpFile, helpContext])=>{
                const n = toLong(fromHost(number));
                if (n === 0)
                {
                    throw new VBRuntimeError(5);
                }
                const known = n > 0 && n <= 0xffff ? MESSAGES[n] : undefined;
                const message = description === undefined ? known ?? UNKNOWN_ERROR
                    : toStr(fromHost(description));
                const error = new VBRuntimeError(n, message,
                    source === undefined ? SOURCE_RUNTIME : toStr(fromHost(source)));
                interp.setErr(error);
                if (helpFile !== undefined)
                {
                    err.helpFile = toStr(fromHost(helpFile));
                }
                if (helpContext !== undefined)
                {
                    err.helpContext = toLong(fromHost(helpContext));
                }
                throw error;
            } },
            Clear: { call: ()=>{
                err.clear();
                return undefined;
            } },
        },
    });
}

/**
 * An array's bound for LBound and UBound: of the dimension given, from 1.
 *
 * @param {Value[]} args @param {boolean} upper @returns {Value}
 */
function bound(args, upper){
    const [array, which] = args;
    if (array === null)
    {
        throw new VBRuntimeError(94);
    }
    if (!(array instanceof VBArray))
    {
        throw new VBRuntimeError(13);
    }
    const dimension = which === undefined ? 1 : toLong(which);
    const b = array.bounds[dimension - 1];
    if (b === undefined)
    {
        throw new VBRuntimeError(9);
    }
    return long(upper ? b.lower + b.count - 1 : b.lower);
}

/**
 * VarType's number: the subtype, an array's element type with vbArray,
 * vbObject for an object.
 *
 * @param {Value} value @returns {number}
 */
function varTypeOf(value){
    if (value instanceof VBArray)
    {
        return VT_ARRAY | value.elementType;
    }
    if (isObject(value))
    {
        return VT_DISPATCH;
    }
    return vtOf(value);
}

/**
 * The core built-ins.
 *
 * @param {Interpreter} interp @param {BuiltinHost} host
 */
export function installCore(interp, host){
    const random = new RandomState();
    /** @param {string} name @param {number} vt */
    const conversion = (name, vt)=>define(interp, name, 1, 1, ([v])=>convertNumber(v, vt));
    conversion('CByte', VT_UI1);
    conversion('CInt', VT_I2);
    conversion('CLng', VT_I4);
    conversion('CSng', VT_R4);
    conversion('CDbl', VT_R8);
    conversion('CCur', VT_CY);
    define(interp, 'CBool', 1, 1, ([v])=>toBool(v));
    define(interp, 'CStr', 1, 1, ([v])=>toStr(v));
    define(interp, 'CDate', 1, 1, ([v])=>date(toDate(v, ()=>interp.options.thisYear?.() ?? null)));
    define(interp, 'Hex', 1, 1, ([v])=>radixText(v, 16));
    define(interp, 'Oct', 1, 1, ([v])=>radixText(v, 8));
    define(interp, 'Fix', 1, 1, ([v])=>keepingType(v, Math.trunc));
    define(interp, 'Int', 1, 1, ([v])=>keepingType(v, Math.floor));
    define(interp, 'Abs', 1, 1, ([v])=>keepingType(v, Math.abs));
    define(interp, 'Round', 1, 2, ([v, places])=>{
        const digits = places === undefined ? 0 : toLong(places);
        if (digits < 0)
        {
            throw new VBRuntimeError(5);
        }
        return keepingType(v, n=>roundNumber(n, digits));
    });
    define(interp, 'Sgn', 1, 1, ([v])=>integer(Math.sign(toDouble(v))));
    define(interp, 'Sqr', 1, 1, ([v])=>{
        const n = toDouble(v);
        if (n < 0)
        {
            throw new VBRuntimeError(5);
        }
        return Math.sqrt(n);
    });
    define(interp, 'Exp', 1, 1, ([v])=>{
        const n = Math.exp(toDouble(v));
        if (!Number.isFinite(n))
        {
            throw new VBRuntimeError(6);
        }
        return n;
    });
    define(interp, 'Log', 1, 1, ([v])=>{
        const n = toDouble(v);
        if (n <= 0)
        {
            throw new VBRuntimeError(5);
        }
        return Math.log(n);
    });
    define(interp, 'Sin', 1, 1, ([v])=>Math.sin(toDouble(v)));
    define(interp, 'Cos', 1, 1, ([v])=>Math.cos(toDouble(v)));
    define(interp, 'Tan', 1, 1, ([v])=>Math.tan(toDouble(v)));
    define(interp, 'Atn', 1, 1, ([v])=>Math.atan(toDouble(v)));
    define(interp, 'Rnd', 0, 1, ([v])=>single(random.rnd(v === undefined ? undefined
        : toDouble(v))));
    define(interp, 'Randomize', 0, 1, ([v])=>{
        if (v === undefined)
        {
            // Randomize alone seeds from Timer, the seconds since midnight.
            const local = host.now() + host.localOffset(host.now());
            random.randomize(Math.fround((((local % 86400000) + 86400000) % 86400000) / 1000));
        }
        else
        {
            random.randomize(toDouble(v));
        }
        return undefined;
    });

    define(interp, 'IsArray', 1, 1, ([v])=>v instanceof VBArray, { raw: true });
    define(interp, 'IsEmpty', 1, 1, ([v])=>v === undefined, { raw: true });
    define(interp, 'IsNull', 1, 1, ([v])=>v === null, { raw: true });
    define(interp, 'IsNumeric', 1, 1, ([v])=>isNumeric(v), { raw: true });
    define(interp, 'IsObject', 1, 1, ([v])=>isObject(v), { raw: true });
    define(interp, 'TypeName', 1, 1, ([v])=>typeName(v), { raw: true });
    define(interp, 'VarType', 1, 1, ([v])=>integer(varTypeOf(v)), { raw: true });

    define(interp, 'Array', 0, Infinity, args=>VBArray.of(args.map(v=>(v instanceof VBArray
        ? v.copy() : v))), { raw: true });
    define(interp, 'LBound', 1, 2, args=>bound(args, false), { raw: true });
    define(interp, 'UBound', 1, 2, args=>bound(args, true), { raw: true });
    define(interp, 'RGB', 3, 3, ([r, g, b])=>{
        /** @param {Value} v */
        const part = v=>Math.min(255, Math.max(0, toLong(v)));
        return long(part(r) | (part(g) << 8) | (part(b) << 16));
    });

    const err = errObject(interp);
    define(interp, 'Err', 0, 0, ()=>err);

    define(interp, 'CreateObject', 1, 2, function*([progId, location], { interp: it }){
        const create = host.createObject;
        if (!create)
        {
            throw new VBRuntimeError(429);
        }
        const name = toStr(progId);
        const where = location === undefined ? undefined : toStr(location);
        const made = fromHost(yield* it.external(()=>create(name, where)));
        if (!isObject(made))
        {
            throw new VBRuntimeError(429);
        }
        return made;
    }, { steps: true });
    define(interp, 'GetObject', 0, 2, function*([path, progId], { interp: it }){
        const get = host.getObject;
        if (!get)
        {
            throw new VBRuntimeError(429);
        }
        const file = path === undefined ? '' : toStr(path);
        const cls = progId === undefined ? undefined : toStr(progId);
        return fromHost(yield* it.external(()=>get(file, cls)));
    }, { steps: true });
    define(interp, 'MsgBox', 1, 5, function*([prompt, buttons, title], { interp: it }){
        const show = host.msgBox;
        if (!show)
        {
            // A host that offered no window to show one in is told no.
            throw new VBRuntimeError(70);
        }
        const text = toStr(prompt ?? '');
        const style = buttons === undefined ? 0 : toLong(buttons);
        const caption = title === undefined ? 'VBScript' : toStr(title);
        return integer(Number(yield* it.external(()=>show(text, style, caption))));
    }, { steps: true });
    define(interp, 'InputBox', 1, 7, function*([prompt, title, fallback], { interp: it }){
        const ask = host.inputBox;
        if (!ask)
        {
            throw new VBRuntimeError(70);
        }
        const answer = yield* it.external(()=>ask(toStr(prompt ?? ''),
            title === undefined ? 'VBScript' : toStr(title),
            fallback === undefined ? '' : toStr(fallback)));
        return answer === null ? '' : String(answer);
    }, { steps: true });

    define(interp, 'Eval', 1, 1, ([text], { interp: it, frame })=>it.evaluate(toStr(text), frame),
        { steps: true });
    define(interp, 'Execute', 1, 1, ([text], { interp: it, frame })=>it.execute(toStr(text), frame,
        false), { steps: true });
    define(interp, 'ExecuteGlobal', 1, 1, ([text], { interp: it, frame })=>it.execute(toStr(text),
        frame, true), { steps: true });
    define(interp, 'GetRef', 1, 1, ([name])=>{
        const proc = interp.procs.get(toStr(name).toLowerCase());
        if (proc === undefined)
        {
            throw new VBRuntimeError(5);
        }
        return new FunctionRef(proc);
    });

    define(interp, 'ScriptEngine', 0, 0, ()=>'VBScript');
    define(interp, 'ScriptEngineMajorVersion', 0, 0, ()=>long(host.version.major));
    define(interp, 'ScriptEngineMinorVersion', 0, 0, ()=>long(host.version.minor));
    define(interp, 'ScriptEngineBuildVersion', 0, 0, ()=>long(host.version.build));
    define(interp, 'GetLocale', 0, 0, ()=>long(0x409));
    define(interp, 'SetLocale', 0, 1, ([lcid])=>{
        if (lcid !== undefined && toLong(lcid) !== 0x409 && toLong(lcid) !== 0)
        {
            host.divergence?.('VBScript SetLocale',
                `locale ${toLong(lcid)}: conversions stay English (United States)`);
        }
        return long(0x409);
    });

    installConstants(interp);
}

/** @param {Interpreter} interp */
function installConstants(interp){
    const strings = {
        vbCr: '\r', vbLf: '\n', vbCrLf: '\r\n', vbNewLine: '\r\n', vbTab: '\t', vbBack: '\b',
        vbFormFeed: '\f', vbVerticalTab: '\v', vbNullChar: '\0', vbNullString: '',
    };
    for (const [name, value] of Object.entries(strings))
    {
        constant(interp, name, value);
    }
    const integers = {
        vbTrue: -1, vbFalse: 0, vbUseDefault: -2, vbBinaryCompare: 0, vbTextCompare: 1,
        vbDatabaseCompare: 2, vbUseSystemDayOfWeek: 0, vbSunday: 1, vbMonday: 2, vbTuesday: 3,
        vbWednesday: 4, vbThursday: 5, vbFriday: 6, vbSaturday: 7, vbUseSystem: 0,
        vbFirstJan1: 1, vbFirstFourDays: 2, vbFirstFullWeek: 3, vbGeneralDate: 0,
        vbLongDate: 1, vbShortDate: 2, vbLongTime: 3, vbShortTime: 4, vbOKOnly: 0,
        vbOKCancel: 1, vbAbortRetryIgnore: 2, vbYesNoCancel: 3, vbYesNo: 4, vbRetryCancel: 5,
        vbCritical: 16, vbQuestion: 32, vbExclamation: 48, vbInformation: 64,
        vbDefaultButton1: 0, vbDefaultButton2: 256, vbDefaultButton3: 512,
        vbDefaultButton4: 768, vbApplicationModal: 0, vbSystemModal: 4096, vbOK: 1,
        vbCancel: 2, vbAbort: 3, vbRetry: 4, vbIgnore: 5, vbYes: 6, vbNo: 7, vbEmpty: 0,
        vbNull: 1, vbInteger: 2, vbLong: 3, vbSingle: 4, vbDouble: 5, vbCurrency: 6, vbDate: 7,
        vbString: 8, vbObject: 9, vbError: 10, vbBoolean: 11, vbVariant: 12, vbDataObject: 13,
        vbDecimal: 14, vbByte: 17, vbArray: 8192, vbMsgBoxHelpButton: 16384,
    };
    for (const [name, value] of Object.entries(integers))
    {
        constant(interp, name, integer(value));
    }
    const longs = {
        vbObjectError: -2147221504, vbMsgBoxSetForeground: 65536, vbMsgBoxRight: 524288,
        vbMsgBoxRtlReading: 1048576, vbBlack: 0, vbRed: 0xff, vbGreen: 0xff00, vbYellow: 0xffff,
        vbBlue: 0xff0000, vbMagenta: 0xff00ff, vbCyan: 0xffff00, vbWhite: 0xffffff,
    };
    for (const [name, value] of Object.entries(longs))
    {
        constant(interp, name, long(value));
    }
}
