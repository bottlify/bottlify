/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What every script engine on this runtime answers an embedder in, whatever
 * its language: an installer runs a JScript or a VBScript custom action by
 * the action's type and nothing else, so the two engines are created, given
 * names, run and failed the same way.
 *
 * - {@link ScriptError}: a script that failed -- the number and description
 *   the language reports, the source it names ("Microsoft VBScript runtime
 *   error"), where in the text, and the HRESULT a COM caller is told.
 * - {@link ScriptAbort}: a stop the embedder asked for, not a failure of the
 *   script and nothing a script can catch.
 * - {@link ScriptEngine}: the embedder's side of an engine.
 *
 * @typedef {import('./values.js').Value} Value
 */

/**
 * A stop the embedder asked for (an interrupted script): not an exception a
 * script can catch, and not a failure of the script.
 */
export class ScriptAbort extends Error
{
    /** @param {string} [reason] */
    constructor(reason = 'script interrupted'){
        super(reason);
        this.name = 'ScriptAbort';
    }
}

/**
 * @typedef {Object} ScriptErrorFields
 * @property {number} number  What the script reads as the error's number:
 *     JScript's signed HRESULT, VBScript's Err.Number.
 * @property {string} description
 * @property {string} source  "Microsoft JScript runtime error", "... compilation error".
 * @property {boolean} syntax  Whether the text did not parse.
 * @property {number} line  From 0, counting from the text's own first line
 *     plus the line the embedder said it starts on.
 * @property {number} column  From 0.
 * @property {string} lineText
 * @property {number} context  The host's cookie for the text.
 * @property {Value} [value]  What the script threw, where the language throws values.
 */

/** A script that failed: what its language would report of it. */
export class ScriptError extends Error
{
    /** @param {ScriptErrorFields} fields */
    constructor(fields){
        super(fields.description || fields.source);
        this.name = 'ScriptError';
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

    /**
     * The HRESULT an EXCEPINFO carries for this error: the number itself
     * where the language's numbers are HRESULTs already.
     *
     * @returns {number}
     */
    get scode(){
        return this.number | 0;
    }
}

/**
 * @typedef {Object} EngineVersion
 * @property {number} major @property {number} minor @property {number} build
 */

/**
 * @typedef {Object} RunOptions
 * @property {boolean} [expression]  The text is one expression, whose value
 *     is the answer (SCRIPTTEXT_ISEXPRESSION).
 * @property {number} [line]  The line the text starts on in its document.
 * @property {number} [context]  The host's cookie for the text, reported back
 *     with an error in it.
 */

/**
 * What every engine takes, beside options of its language's own.
 *
 * @typedef {Object} ScriptEngineOptions
 * @property {EngineVersion} [version]  What the script is told it runs on.
 * @property {() => number} [now]  The machine's clock, in milliseconds since
 *     1970 UTC; the host's when absent.
 * @property {(utc: number) => number} [localOffset]  How far the machine's
 *     time zone is ahead of UTC at an instant, in milliseconds; none when absent.
 * @property {() => number} [random]
 * @property {(progId: string, location: string | undefined)
 *     => Value | Promise<Value>} [createObject]
 *     The classes a script creates by ProgID: an external object, or an
 *     ExternalError.
 * @property {(path: string, progId: string | undefined)
 *     => Value | Promise<Value>} [getObject]
 * @property {() => void | Promise<void>} [checkpoint]  Called every so many
 *     loop iterations and calls: may wait, or throw {@link ScriptAbort}.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {boolean} [fastPaths]  False runs everything through the
 *     generator evaluator: the second arm of an engine's gate, never set
 *     otherwise.
 */

/**
 * The embedder's side of an engine. Values cross as plain host values -- a
 * number, a string, a boolean, undefined for empty, null, an external
 * object, a {@link import('./values.js').ForeignValue} for a date or an
 * array -- whatever the language makes of them inside.
 *
 * @typedef {Object} ScriptEngine
 * @property {(name: string, value: Value) => void} addNamedItem  A name the
 *     script can use: a host object such as an installer's Session.
 * @property {(text: string, options?: RunOptions) => Promise<Value>} run
 *     Parses and runs a text as global code; an expression text answers its value.
 * @property {(name: string, args?: Value[]) => Promise<Value>} call  Calls a
 *     global function by name, as an installer calls a custom action's.
 * @property {(reason?: string) => void} interrupt  Stops a running script
 *     at its next loop iteration or call, which rejects with {@link ScriptAbort}.
 */
