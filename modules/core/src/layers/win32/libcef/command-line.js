/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cef_command_line_t: a command line as Chromium reads one (base::CommandLine).
 * The first token is the program; a token that starts with `--`, `-` or `/` is
 * a switch, its name lower-cased on Windows and its value after `=`; `--`
 * alone ends the switches; anything else is an argument.
 */

/**
 * Splits a command line as CommandLineToArgvW does: white space separates,
 * quotes group, 2n backslashes before a quote are n and the quote counts,
 * 2n+1 are n and a literal quote.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitCommandLine(text){
    /** @type {string[]} */
    const out = [];
    let at = 0;
    while (at < text.length)
    {
        while (at < text.length && /\s/.test(text[at]))
        {
            at++;
        }
        if (at >= text.length)
        {
            break;
        }
        let token = '';
        let quoted = false;
        for (; at < text.length && (quoted || !/\s/.test(text[at])); at++)
        {
            let slashes = 0;
            while (text[at] === '\\')
            {
                slashes++;
                at++;
            }
            if (text[at] === '"')
            {
                token += '\\'.repeat(slashes >> 1);
                if (slashes % 2 === 1)
                {
                    token += '"';
                }
                else
                {
                    quoted = !quoted;
                }
                continue;
            }
            token += '\\'.repeat(slashes);
            if (at < text.length && (quoted || !/\s/.test(text[at])))
            {
                token += text[at];
            }
            else
            {
                at--;
            }
        }
        out.push(token);
    }
    return out;
}

/**
 * A command line's parts.
 *
 * @typedef {Object} CommandLine
 * @property {string} program
 * @property {[string, string][]} switches  In order, names lower-cased.
 * @property {string[]} args
 */

/** @returns {CommandLine} */
export const emptyCommandLine = ()=>({ program: '', switches: [], args: [] });

/**
 * @param {string[]} tokens  The program first.
 * @returns {CommandLine}
 */
export function parseCommandLine(tokens){
    const line = emptyCommandLine();
    line.program = tokens[0] ?? '';
    let switching = true;
    for (const token of tokens.slice(1))
    {
        if (switching && token === '--')
        {
            switching = false;
            continue;
        }
        const prefix = switching ? /^(--|-|\/)(?=.)/.exec(token) : null;
        if (prefix)
        {
            appendSwitch(line, token.slice(prefix[0].length));
        }
        else
        {
            line.args.push(token);
        }
    }
    return line;
}

/** @param {CommandLine} line @param {string} text  `name` or `name=value`. */
function appendSwitch(line, text){
    const equals = text.indexOf('=');
    const name = (equals < 0 ? text : text.slice(0, equals)).toLowerCase();
    setSwitch(line, name, equals < 0 ? '' : text.slice(equals + 1));
}

/** @param {CommandLine} line @param {string} name @param {string} value */
function setSwitch(line, name, value){
    const at = line.switches.findIndex(([key])=>key === name);
    if (at >= 0)
    {
        line.switches[at][1] = value;
    }
    else
    {
        line.switches.push([name, value]);
    }
}

/** @param {string} token  Quoted when it has to be, as Chromium writes one back. */
const quote = token=>(token === '' || /[\s"]/.test(token)
    ? `"${token.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : token);

/** @param {CommandLine} line */
export function argvOf(line){
    return [line.program, ...line.switches.map(([name, value])=>(value === ''
        ? `--${name}` : `--${name}=${value}`)), ...line.args];
}

/** @param {CommandLine} line */
export const commandLineString = line=>argvOf(line).map(quote).join(' ');

/**
 * The type's methods, in cef_command_line_capi.h's order.
 *
 * @param {{ read: (at: number) => string, userfree: (text: string) => number,
 *     fillList: (handle: number, items: string[]) => void,
 *     fillMap: (handle: number, pairs: [string, string][]) => void,
 *     argv: (count: number, at: number) => string[],
 *     copy: (line: CommandLine) => number }} strings
 * @returns {import('./objects.js').CefMethod[]}
 */
export function commandLineMethods(strings){
    /** @param {string} name @param {number} argBytes @param {(line: CommandLine, args: number[]) => any} fn */
    const method = (name, argBytes, fn)=>({ name, argBytes,
        handler: (/** @type {any} */ state, /** @type {number[]} */ args)=>fn(state.line, args) ?? 0 });
    /** @param {CommandLine} line @param {number} at */
    const valueOf = (line, at)=>line.switches.find(([key])=>key === strings.read(at).toLowerCase());
    return [
        method('is_valid', 4, ()=>1),
        method('is_read_only', 4, ()=>0),
        method('copy', 4, line=>strings.copy(structuredClone(line))),
        method('init_from_argv', 12, (line, [count, at])=>{
            Object.assign(line, parseCommandLine(strings.argv(count | 0, at)));
        }),
        method('init_from_string', 8, (line, [at])=>{
            Object.assign(line, parseCommandLine(splitCommandLine(strings.read(at))));
        }),
        method('reset', 4, line=>{
            Object.assign(line, emptyCommandLine(), { program: line.program });
        }),
        method('get_argv', 8, (line, [handle])=>strings.fillList(handle, argvOf(line))),
        method('get_command_line_string', 4, line=>strings.userfree(commandLineString(line))),
        method('get_program', 4, line=>strings.userfree(line.program)),
        method('set_program', 8, (line, [at])=>{
            line.program = strings.read(at);
        }),
        method('has_switches', 4, line=>(line.switches.length > 0 ? 1 : 0)),
        method('has_switch', 8, (line, [at])=>(valueOf(line, at) ? 1 : 0)),
        method('get_switch_value', 8, (line, [at])=>{
            const found = valueOf(line, at);
            return found ? strings.userfree(found[1]) : 0;
        }),
        method('get_switches', 8, (line, [handle])=>strings.fillMap(handle,
            line.switches.map(([name, value])=>[name, value]))),
        method('append_switch', 8, (line, [at])=>setSwitch(line,
            strings.read(at).toLowerCase(), '')),
        method('append_switch_with_value', 12, (line, [at, value])=>setSwitch(line,
            strings.read(at).toLowerCase(), strings.read(value))),
        method('has_arguments', 4, line=>(line.args.length > 0 ? 1 : 0)),
        method('get_arguments', 8, (line, [handle])=>strings.fillList(handle, line.args)),
        method('append_argument', 8, (line, [at])=>void line.args.push(strings.read(at))),
        method('prepend_wrapper', 8, (line, [at])=>{
            // ponytail: the wrapper's own switches land among the arguments,
            // after the program they wrap; Chromium keeps them before it.
            const wrapper = splitCommandLine(strings.read(at));
            if (wrapper.length > 0)
            {
                line.args = [...wrapper.slice(1), line.program, ...line.args];
                line.program = wrapper[0];
            }
        }),
    ];
}
