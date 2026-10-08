/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A JScript engine for a host-side embedder: an installer running a JScript
 * custom action, or the active-script class a program creates.
 *
 * The engine runs a script's text with the names the embedder gave it --
 * external objects such as an installer's Session -- and calls the script's
 * functions by name. Everything a script does is interpreted here: the text
 * never reaches the host's own JavaScript engine, and the script sees no
 * object but its own and the ones it was given.
 *
 * A failure of the script comes back as a {@link JScriptError}: the error
 * number and description JScript reports, the text's line and column, and
 * the value the script threw.
 */

import { drive } from '../script/drive.js';
import { ExternalObject } from '../script/external.js';
import { installArray } from './builtins-array.js';
import { installCore } from './builtins-core.js';
import { installDate } from './builtins-date.js';
import { installJScript } from './builtins-jscript.js';
import { installNumber } from './builtins-number.js';
import { installString } from './builtins-string.js';
import {
    MESSAGES, SOURCE_COMPILATION, SOURCE_RUNTIME, SyntaxFailure, errorNumber,
} from './errors.js';
import { Interpreter } from './interpreter.js';
import { conditionalVariables, positionOf } from './lexer.js';
import {
    DONTDELETE, DONTENUM, JSFunction, JSObject, ObjectScope, ScriptAbort, ScriptThrow,
} from './objects.js';
import { parseExpressionProgram, parseProgram } from './parser.js';
import { Realm } from './realm.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./realm.js').EngineVersion} EngineVersion
 */

/**
 * The version JScript 5.6 reports, as Windows XP's own update of it does:
 * ScriptEngineMajorVersion 5, minor 6, build 8835.
 *
 * @type {Readonly<EngineVersion>}
 */
export const JSCRIPT_5_6 = Object.freeze({ major: 5, minor: 6, build: 8835 });

/**
 * @typedef {Object} JScriptOptions
 * @property {EngineVersion} [version]  What the script is told it runs on.
 * @property {() => number} [now]  The machine's clock, in milliseconds since
 *     1970 UTC; the host's when absent.
 * @property {(utc: number) => number} [localOffset]  How far the machine's
 *     time zone is ahead of UTC at an instant, in milliseconds; absent, none:
 *     the zone kernel32's GetTimeZoneInformation reports is UTC.
 * @property {() => number} [random]
 * @property {(progId: string, location: string | undefined)
 *     => ExternalObject | Promise<ExternalObject>} [createObject]
 *     ActiveXObject's classes.
 * @property {(path: string, progId: string | undefined)
 *     => ExternalObject | Promise<ExternalObject>} [getObject]
 * @property {() => void | Promise<void>} [checkpoint]  Called every so many
 *     loop iterations and calls: may wait, or throw {@link ScriptAbort}.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {boolean} [fastPaths]  False runs every expression through the
 *     generator evaluator: the second arm of the gate test, never set
 *     otherwise.
 */

/** A script that failed: what JScript would report of it. */
export class JScriptError extends Error
{
    /**
     * @param {Object} fields
     * @param {number} fields.number  The signed HRESULT a script reads as `e.number`.
     * @param {string} fields.description
     * @param {string} fields.source  "Microsoft JScript runtime error" or "... compilation error".
     * @param {boolean} fields.syntax  Whether the text did not parse.
     * @param {number} fields.line  From 0, counting from the text's own first line.
     * @param {number} fields.column  From 0.
     * @param {string} fields.lineText
     * @param {number} fields.context  The host's cookie for the text.
     * @param {Value} [fields.value]  What the script threw.
     */
    constructor(fields){
        super(fields.description || fields.source);
        this.name = 'JScriptError';
        this.number = fields.number;
        this.description = fields.description;
        this.source = fields.source;
        this.syntax = fields.syntax;
        this.line = fields.line;
        this.column = fields.column;
        this.lineText = fields.lineText;
        this.context = fields.context;
        this.value = fields.value;
    }
}

/**
 * @typedef {Object} RunOptions
 * @property {boolean} [expression]  The text is one expression, whose value
 *     is the answer (SCRIPTTEXT_ISEXPRESSION).
 * @property {number} [line]  The line the text starts on in its document.
 * @property {number} [context]  The host's cookie for the text, reported back
 *     with an error in it.
 */

export class JScriptEngine
{
    /** @param {JScriptOptions} [options] */
    constructor(options = {}){
        this.options = options;
        const version = options.version ?? JSCRIPT_5_6;
        this.realm = new Realm({
            version,
            now: options.now ?? (()=>Date.now()),
            localOffset: options.localOffset ?? (()=>0),
            random: options.random ?? Math.random,
            createObject: options.createObject,
            getObject: options.getObject,
            divergence: options.divergence,
        });
        /** The conditional-compilation state, which lasts from one text to the next. */
        this.conditional = conditionalVariables(version);
        this.ccState = { ccOn: false };
        this.interpreter = new Interpreter(this.realm, {
            checkpoint: options.checkpoint,
            parse: { conditional: this.conditional, ccState: this.ccState },
            fastPaths: options.fastPaths,
        });
        installCore(this.realm);
        installArray(this.realm);
        installString(this.realm);
        installNumber(this.realm);
        installDate(this.realm);
        installJScript(this.realm);
    }

    /** The global object, which a host may read and give names on. */
    get global(){
        return this.realm.global;
    }

    /**
     * Gives the script a name: a host object such as an installer's
     * Session, or any value. The name cannot be deleted or enumerated.
     *
     * @param {string} name @param {Value} value
     */
    addNamedItem(name, value){
        this.realm.global.define(name, value, DONTENUM | DONTDELETE);
    }

    /**
     * Makes an object's members names of the global scope, found after the
     * global object's own: an active script's SCRIPTITEM_GLOBALMEMBERS item.
     * Later ones are searched after earlier ones.
     *
     * @param {ExternalObject} object
     */
    addGlobalMembers(object){
        let last = this.interpreter.globalScope;
        while (last.parent !== null)
        {
            last = /** @type {ObjectScope} */ (last.parent);
        }
        last.parent = new ObjectScope(object, null, false);
    }

    /**
     * Asks the host for a name the script uses and nothing defines -- an
     * active script's named items, made only when first used. The answer
     * may be a promise; undefined means the host has no such name.
     *
     * @param {(name: string) => Value | Promise<Value> | undefined} resolve
     */
    setNameResolver(resolve){
        const realm = this.realm;
        realm.globalFallback = function*(name){
            const found = yield* realm.external(()=>resolve(name));
            return found === undefined ? null : { value: found };
        };
    }

    /**
     * Parses a text without running it: a syntax error is thrown here as a
     * {@link JScriptError}.
     *
     * @param {string} text @param {RunOptions} [options]
     * @returns {import('./parser.js').FunctionNode}
     */
    parse(text, options = {}){
        const parse = { conditional: this.conditional, ccState: this.ccState,
            line: options.line, context: options.context };
        try
        {
            return options.expression
                ? parseExpressionProgram(text, parse) : parseProgram(text, parse);
        }
        catch (e){
            throw this.failure(e, { text, line: options.line ?? 0, context: options.context ?? 0 });
        }
    }

    /**
     * Runs a parsed text as global code: its functions and vars become the
     * global object's, then its statements run. Answers the value of its
     * last expression statement, which for an expression text is the
     * expression's value.
     *
     * @param {import('./parser.js').FunctionNode} program
     * @returns {Promise<Value>}
     */
    async execute(program){
        return this.settle(()=>this.interpreter.runProgram(program));
    }

    /**
     * Parses and runs a text.
     *
     * @param {string} text @param {RunOptions} [options]
     * @returns {Promise<Value>}
     */
    async run(text, options = {}){
        return this.execute(this.parse(text, options));
    }

    /**
     * Calls a global function by name: how an installer runs a custom
     * action's function after its script has run.
     *
     * @param {string} name @param {Value[]} [args]
     * @returns {Promise<Value>}
     */
    async call(name, args = []){
        const fn = this.realm.global.get(name);
        if (fn === undefined && !this.realm.global.has(name))
        {
            throw new JScriptError({
                number: errorNumber(5009), description: `'${name}' is undefined`,
                source: SOURCE_RUNTIME, syntax: false, line: 0, column: 0, lineText: '',
                context: 0,
            });
        }
        return this.callFunction(fn, undefined, args);
    }

    /**
     * Calls a function value -- the script's, or anything callable -- with
     * a `this` and arguments.
     *
     * @param {Value} fn @param {Value} thisValue @param {Value[]} args
     * @returns {Promise<Value>}
     */
    async callFunction(fn, thisValue, args){
        return this.settle(()=>this.realm.call(fn, thisValue, args));
    }

    /**
     * Whether a value is something the script can call.
     *
     * @param {Value} value @returns {boolean}
     */
    isCallable(value){
        return value instanceof JSFunction || value instanceof ExternalObject;
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
     * Runs steps to their end, with failures as JScript reports them.
     *
     * @param {() => Generator<unknown, Value, unknown>} steps
     * @returns {Promise<Value>}
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
            return new JScriptError({
                number: errorNumber(e.code), description: MESSAGES[e.code] ?? 'Syntax error',
                source: SOURCE_COMPILATION, syntax: true, line: parsing.line + at.line,
                column: at.column, lineText: at.lineText, context: parsing.context,
            });
        }
        let thrown = e;
        if (!(thrown instanceof ScriptThrow))
        {
            if (thrown instanceof ScriptAbort || !(thrown instanceof RangeError))
            {
                return thrown;
            }
            thrown = this.realm.error('Error', 28);
        }
        const { value, where } = /** @type {ScriptThrow} */ (thrown);
        const source = where?.source ?? null;
        const at = source === null ? { line: 0, column: 0, lineText: '' }
            : positionOf(source.text, where?.offset ?? 0);
        let number = errorNumber(5022);
        let description = MESSAGES[5022];
        if (value instanceof JSObject && value.cls === 'Error')
        {
            const n = value.get('number');
            const d = value.get('description');
            number = typeof n === 'number' ? n | 0 : 0;
            description = typeof d === 'string' ? d : '';
            const syntax = value.proto === this.realm.errorPrototypes.get('SyntaxError');
            return new JScriptError({
                number, description, source: syntax ? SOURCE_COMPILATION : SOURCE_RUNTIME,
                syntax: false, line: (source?.line ?? 0) + at.line, column: at.column,
                lineText: at.lineText, context: source?.context ?? 0, value,
            });
        }
        return new JScriptError({
            number, description, source: SOURCE_RUNTIME, syntax: false,
            line: (source?.line ?? 0) + at.line, column: at.column, lineText: at.lineText,
            context: source?.context ?? 0, value,
        });
    }
}

/**
 * A new engine, its built-ins installed and nothing run yet.
 *
 * @param {JScriptOptions} [options] @returns {JScriptEngine}
 */
export function createJScriptEngine(options){
    return new JScriptEngine(options);
}

export { ScriptAbort };
