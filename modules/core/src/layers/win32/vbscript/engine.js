/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A VBScript engine for a host-side embedder: an installer running a
 * VBScript custom action, or the active-script class a program creates. Its
 * face is JScript's (`jscript/engine.js`) -- the same calls, the same
 * options, failures of the same shape (`script/engine.js`) -- so that an
 * embedder picks one by the script's language and treats the two alike.
 *
 * Everything a script does is interpreted here: the text never reaches the
 * host's own JavaScript engine, and the script sees no object but its own
 * and the ones it was given.
 *
 * Values cross to the embedder as plain host values: run and call answer a
 * number of any subtype as a number, an array as a SAFEARRAY's contents (a
 * ForeignValue), Nothing as null; what the embedder hands in -- a named
 * item's answers, call's arguments -- is read the same way back, a whole
 * number as a Long.
 *
 * A failure of the script comes back as a {@link VBScriptError}: Err.Number,
 * Err.Description and Err.Source as the script would have read them, and the
 * line and column of the statement that failed.
 */

import { drive } from '../script/drive.js';
import { ScriptAbort, ScriptError } from '../script/engine.js';
import { ExternalObject } from '../script/external.js';
import { wallTimeToOleDate } from '../script/values.js';
import { fieldsOf } from '../oleaut32/dates.js';
import { installCore } from './builtins.js';
import { installDates } from './builtins-date.js';
import { installStrings } from './builtins-string.js';
import {
    MESSAGES, SOURCE_COMPILATION, SOURCE_RUNTIME, SyntaxFailure, VBRuntimeError, hresultOf,
} from './errors.js';
import { Interpreter, Var } from './interpreter.js';
import { positionOf } from './lexer.js';
import { parseExpressionProgram, parseProgram } from './parser.js';
import { createRegExp } from './regexp.js';
import { FunctionRef, fromHost, toHost } from './values.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('../script/engine.js').EngineVersion} EngineVersion
 * @typedef {import('../script/engine.js').RunOptions} RunOptions
 * @typedef {import('./parser.js').Program} Program
 */

/**
 * The version VBScript 5.7 reports, as Windows XP Service Pack 3's
 * vbscript.dll does: ScriptEngineMajorVersion 5, minor 7, build 18066.
 *
 * @type {Readonly<EngineVersion>}
 */
export const VBSCRIPT_5_7 = Object.freeze({ major: 5, minor: 7, build: 18066 });

/**
 * The shared options (`script/engine.js`), and VBScript's own. `random` is
 * not read: Rnd is VBScript's own generator, seeded as Visual Basic seeds it.
 *
 * @typedef {import('../script/engine.js').ScriptEngineOptions & {
 *     msgBox?: (prompt: string, buttons: number, title: string) => number | Promise<number>,
 *     inputBox?: (prompt: string, title: string, fallback: string)
 *         => string | null | Promise<string | null>,
 * }} VBScriptOptions
 *     `msgBox` and `inputBox` show MsgBox and InputBox; without them both are
 *     error 70, "Permission denied", as in a host that has no window.
 */

/** A script that failed: what VBScript would report of it. */
export class VBScriptError extends ScriptError
{
    /** @param {import('../script/engine.js').ScriptErrorFields} fields */
    constructor(fields){
        super(fields);
        this.name = 'VBScriptError';
    }

    /** The HRESULT a COM caller is told: VBScript's own numbers in FACILITY_CONTROL. */
    get scode(){
        return hresultOf(this.number);
    }
}

export class VBScriptEngine
{
    /** @param {VBScriptOptions} [options] */
    constructor(options = {}){
        this.options = options;
        const now = options.now ?? (()=>Date.now());
        const localOffset = options.localOffset ?? (()=>0);
        const thisYear = ()=>{
            const utc = now();
            return fieldsOf(wallTimeToOleDate(utc + localOffset(utc)))?.year ?? null;
        };
        this.interpreter = new Interpreter({
            checkpoint: options.checkpoint,
            fastPaths: options.fastPaths,
            thisYear,
        });
        const host = {
            version: options.version ?? VBSCRIPT_5_7,
            now,
            localOffset,
            createObject: options.createObject,
            getObject: options.getObject,
            msgBox: options.msgBox,
            inputBox: options.inputBox,
            divergence: options.divergence,
        };
        installCore(this.interpreter, host);
        installStrings(this.interpreter);
        installDates(this.interpreter, host);
        this.interpreter.builtinClasses.set('regexp', ()=>createRegExp());
        this.thisYear = thisYear;
    }

    /**
     * Gives the script a name: a host object such as an installer's
     * Session, or any value.
     *
     * @param {string} name @param {Value} value
     */
    addNamedItem(name, value){
        this.interpreter.items.set(name.toLowerCase(), { name, value: fromHost(value) });
    }

    /**
     * Makes an object's members names of the global scope, found after
     * everything else: an active script's SCRIPTITEM_GLOBALMEMBERS item.
     *
     * @param {ExternalObject} object
     */
    addGlobalMembers(object){
        this.interpreter.globalMembers.push(object);
    }

    /**
     * Asks the host for a name the script uses and nothing defines -- an
     * active script's named items, made only when first used. The answer
     * may be a promise; undefined means the host has no such name.
     *
     * @param {(name: string) => Value | Promise<Value> | undefined} resolve
     */
    setNameResolver(resolve){
        this.interpreter.resolver = resolve;
        this.interpreter.unresolved.clear();
    }

    /**
     * Parses a text without running it: a syntax error is thrown here as a
     * {@link VBScriptError}.
     *
     * @param {string} text @param {RunOptions} [options] @returns {Program}
     */
    parse(text, options = {}){
        const parse = { line: options.line, context: options.context, thisYear: this.thisYear };
        try
        {
            return options.expression ? parseExpressionProgram(text, parse)
                : parseProgram(text, parse);
        }
        catch (e){
            throw this.failure(e, { text, line: options.line ?? 0,
                context: options.context ?? 0 });
        }
    }

    /**
     * Runs a parsed text as global code: its procedures, classes, variables
     * and constants become global, then its statements run. Answers an
     * expression text's value as VBScript holds it -- subtype and all, for
     * a caller that writes it into a VARIANT.
     *
     * @param {Program} program @returns {Promise<Value>}
     */
    async execute(program){
        return this.settle(()=>this.interpreter.runProgram(program));
    }

    /**
     * Parses and runs a text; an expression text answers its value, plain.
     *
     * @param {string} text @param {RunOptions} [options] @returns {Promise<Value>}
     */
    async run(text, options = {}){
        return toHost(await this.execute(this.parse(text, options)));
    }

    /**
     * Calls a global procedure by name: how an installer runs a custom
     * action's function after its script has run. The arguments are passed
     * by value; the answer is plain.
     *
     * @param {string} name @param {Value[]} [args] @returns {Promise<Value>}
     */
    async call(name, args = []){
        const proc = this.interpreter.procs.get(name.toLowerCase());
        if (proc === undefined)
        {
            throw new VBScriptError({
                number: 13, description: MESSAGES[13], source: SOURCE_RUNTIME, syntax: false,
                line: 0, column: 0, lineText: '', context: 0,
            });
        }
        return toHost(await this.callFunction(new FunctionRef(proc), undefined, args));
    }

    /**
     * Calls something callable -- a procedure GetRef made, an object's
     * default member -- with arguments; `thisValue` is not VBScript's and
     * is not read. Answers as VBScript holds the value.
     *
     * @param {Value} fn @param {Value} _thisValue @param {Value[]} args
     * @returns {Promise<Value>}
     */
    async callFunction(fn, _thisValue, args){
        const interp = this.interpreter;
        return this.settle(function*(){
            const answer = yield* interp.callDefault(fn, args.map(fromHost));
            yield* interp.flush(0);
            return answer;
        });
    }

    /**
     * Whether a value is something the script can call.
     *
     * @param {Value} value @returns {boolean}
     */
    isCallable(value){
        return value instanceof FunctionRef || value instanceof ExternalObject;
    }

    /**
     * A global variable's value, plain; undefined for one the script does
     * not have.
     *
     * @param {string} name @returns {Value}
     */
    getGlobal(name){
        return toHost(this.interpreter.globals.get(name.toLowerCase())?.value);
    }

    /**
     * Sets a global variable, declaring it if the script has not.
     *
     * @param {string} name @param {Value} value
     */
    setGlobal(name, value){
        const key = name.toLowerCase();
        const interp = this.interpreter;
        let variable = interp.globals.get(key);
        if (variable === undefined)
        {
            variable = new Var(undefined);
            interp.globals.set(key, variable);
        }
        interp.assignRef(variable, fromHost(value));
    }

    /**
     * Asks a running script to stop at its next loop iteration or call; the
     * run then rejects with {@link ScriptAbort}.
     *
     * @param {string} [reason]
     */
    interrupt(reason = 'script interrupted'){
        this.interpreter.interrupt(reason);
    }

    /**
     * Lets the script's objects go, as closing the engine does: every
     * instance's Class_Terminate runs.
     *
     * @returns {Promise<void>}
     */
    async close(){
        await this.settle(()=>this.interpreter.close());
    }

    /**
     * Runs steps to their end, with failures as VBScript reports them.
     *
     * @param {() => Generator<unknown, Value, unknown>} steps @returns {Promise<Value>}
     */
    async settle(steps){
        try
        {
            return await drive(steps());
        }
        catch (e){
            throw this.failure(e, null);
        }
    }

    /**
     * What escaped a script, as the error an embedder is handed.
     *
     * @param {unknown} e
     * @param {{ text: string, line: number, context: number } | null} parsing
     *     The text being parsed, for a syntax error.
     * @returns {unknown}
     */
    failure(e, parsing){
        if (e instanceof SyntaxFailure && parsing !== null)
        {
            const at = positionOf(parsing.text, e.position);
            return new VBScriptError({
                number: e.code, description: MESSAGES[e.code] ?? MESSAGES[1002],
                source: SOURCE_COMPILATION, syntax: true, line: parsing.line + at.line,
                column: at.column, lineText: at.lineText, context: parsing.context,
            });
        }
        if (e instanceof ScriptAbort || e instanceof VBScriptError)
        {
            return e;
        }
        let error;
        try
        {
            error = this.interpreter.catchable(e);
        }
        catch {
            return e;
        }
        const where = error.where;
        const at = where === null ? { line: 0, column: 0, lineText: '' }
            : positionOf(where.source.text, where.offset);
        return new VBScriptError({
            number: error.number, description: error.description, source: error.source,
            syntax: false, line: (where?.source.line ?? 0) + at.line, column: at.column,
            lineText: at.lineText, context: where?.source.context ?? 0,
        });
    }
}

/**
 * A new engine, its built-ins installed and nothing run yet.
 *
 * @param {VBScriptOptions} [options] @returns {VBScriptEngine}
 */
export function createVBScriptEngine(options){
    return new VBScriptEngine(options);
}

export { ScriptAbort, VBRuntimeError };
