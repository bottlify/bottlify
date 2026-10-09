/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HLSL source to a Direct3D 9 shader: the whole pipeline of D3DXCompileShader.
 *
 * The text goes through the preprocessor (`preprocess.js`) with the program's
 * macros and its includes, comes out as tokens and a tree (`hlsl-parser.js`),
 * is type-checked (`hlsl-check.js`), run symbolically from the entry point
 * (`hlsl-lower.js`) into straight-line code, and is given registers and written
 * as bytecode with its constant table (`hlsl-backend.js`).
 *
 * Errors are reported in the form fxc prints, `file(line,col): error Xnnnn:
 * text`, one to a line; so are warnings, which do not stop the compile.
 */

import { preprocessTracked } from './preprocess.js';
import { HlslError, formatDiagnostic } from './hlsl-lexer.js';
import { parse } from './hlsl-parser.js';
import { check } from './hlsl-check.js';
import { LowerError, lower } from './hlsl-lower.js';
import { assemble } from './hlsl-backend.js';
import { assembleLegacy } from './hlsl-backend-legacy.js';
import { TargetError, profileOf } from './hlsl-ir.js';

/** D3DXSHADER_*, the flags the compiler reads. */
export const D3DXSHADER = Object.freeze({
    PACKMATRIX_ROWMAJOR: 1 << 3,
    PACKMATRIX_COLUMNMAJOR: 1 << 4,
});

/**
 * @typedef {Object} CompileOptions
 * @property {string} [entry]      The function to compile; 'main' when absent.
 * @property {string} profile      'vs_2_0', 'ps_3_0' and the like.
 * @property {number} [flags]
 * @property {[string, string][]} [defines]
 * @property {import('./preprocess.js').PreprocessOptions['include']} [include]
 * @property {import('./hlsl-parser.js').Expr[]} [arguments]
 *           What an effect's `compile ps_2_0 main(...)` passes: one value for each uniform
 *           parameter of the entry point, in order, which becomes a constant of the shader
 *           rather than a register the program sets.
 */

/**
 * @typedef {Object} CompileResult
 * @property {Uint32Array | null} tokens   The shader, or null when it did not compile.
 * @property {Uint8Array | null} constantTable   The CTAB block, from its header.
 * @property {string} messages   Every error and warning, one to a line; empty for none.
 * @property {boolean} ok
 * @property {Pick<import('./hlsl-ir.js').IrProgram, 'inputs' | 'outputs' | 'constants'>
 *     & { profile: import('./hlsl-ir.js').Profile } | null} info
 *           What the program reads and writes and where the registers were put, for a tool that
 *           feeds the shader and reads it back.
 */

/**
 * The text with `#line` directives wherever a line does not follow the one
 * before it in the file it came from, so that a position in an included file
 * names that file and its own line.
 *
 * @param {string} text @param {import('./preprocess.js').Origin[]} origins
 * @returns {string}
 */
export function withLineMarkers(text, origins){
    const lines = text.split('\n');
    /** @type {string[]} */
    const out = [];
    let file = 'memory';
    let line = 1;
    lines.forEach((one, i)=>{
        const origin = origins[i];
        if (origin && (origin.file !== file || origin.line !== line))
        {
            out.push(`#line ${origin.line} "${origin.file}"`);
            file = origin.file;
            line = origin.line;
        }
        out.push(one);
        line++;
    });
    return out.join('\n');
}

/**
 * Compiles one entry point.
 *
 * @param {string} source
 * @param {CompileOptions} options
 * @returns {Promise<CompileResult>}
 */
export async function compileShader(source, options){
    try
    {
        return await compile(source, options);
    }
    catch (e){
        // A fault in the compiler is a compile that failed, not a program that stopped.
        return { tokens: null, constantTable: null, info: null, ok: false,
            messages: `error X0000: internal compiler error: ${
                /** @type {Error} */ (e)?.stack ?? e}\n` };
    }
}

/**
 * @param {string} source
 * @param {CompileOptions} options
 * @returns {Promise<CompileResult>}
 */
async function compile(source, options){
    /** @type {string[]} */
    const messages = [];
    /** @param {Parameters<typeof formatDiagnostic>[0]} d */
    const report = d=>{
        // A missing entry point belongs to no line.
        messages.push(d.code === 'X3501' ? `error X3501: ${d.message}` : formatDiagnostic(d));
    };
    /** @returns {CompileResult} */
    const failed = ()=>({ tokens: null, constantTable: null, info: null,
        messages: messages.map(m=>`${m}\n`).join(''), ok: false });

    const profile = profileOf(options.profile);
    if (!profile)
    {
        messages.push(`error X3506: '${options.profile}': invalid compiler target; this compiler `
            + 'targets vs_1_1, vs_2_0, vs_2_a, vs_3_0, ps_1_1 to ps_1_4, ps_2_0, ps_2_a, ps_2_b '
            + 'and ps_3_0');
        return failed();
    }
    const entryName = options.entry || 'main';

    const expanded = await preprocessTracked(source, {
        defines: options.defines, include: options.include });
    if ('error' in expanded)
    {
        messages.push(`${expanded.error.replace(/^([^:]*?)(\(\d+\))?: /, (_, file, line)=>
            `${file}${line ?? ''}: error X3000: `)}`);
        return failed();
    }

    let program;
    try
    {
        program = parse(withLineMarkers(expanded.text, expanded.origins));
    }
    catch (e){
        if (!(e instanceof HlslError))
        {
            throw e;
        }
        report({ code: e.code, message: e.message, pos: e.pos });
        return failed();
    }

    if (options.arguments && options.arguments.length > 0)
    {
        const bound = bindArguments(program, entryName, options.arguments);
        if (bound)
        {
            report(bound);
            return failed();
        }
    }

    // The flag is the packing before any `#pragma pack_matrix`; each declaration takes the
    // last one before it.
    const rowMajor = ((options.flags ?? 0) & D3DXSHADER.PACKMATRIX_ROWMAJOR) !== 0;
    const { module, diagnostics } = check(program, { entry: entryName, rowMajor });
    for (const d of diagnostics)
    {
        report(d);
    }
    if (diagnostics.some(d=>d.severity === 'error'))
    {
        return failed();
    }
    const entry = module.findFunction(entryName);
    if (!entry || !entry.decl.body)
    {
        messages.push(`error X3501: '${entryName}': entrypoint not found`);
        return failed();
    }

    let ir;
    try
    {
        // A loop that does not unroll is run as a loop where the model has them, and the
        // entry lowered again; a loop in it may not unroll either.
        const loops = new Set();
        for (;;)
        {
            try
            {
                ({ ir } = lower(module, entry, profile, { loops }));
                break;
            }
            catch (e){
                if (!(e instanceof LowerError) || !e.loop || profile.major < 3
                    || loops.has(e.loop))
                {
                    throw e;
                }
                loops.add(e.loop);
            }
        }
    }
    catch (e){
        if (!(e instanceof LowerError) && !(e instanceof TargetError))
        {
            throw e;
        }
        report({ code: e.code, message: e.message,
            pos: (e instanceof LowerError ? e.pos : null) ?? entry.decl.pos });
        return failed();
    }

    const assembled = profile.legacy ? assembleLegacy(ir) : assemble(ir);
    for (const d of assembled.diagnostics)
    {
        report({ code: d.code, message: d.message, severity: d.severity, pos: entry.decl.pos });
    }
    if (!assembled.tokens)
    {
        return failed();
    }
    return { tokens: assembled.tokens, constantTable: constantTableOf(assembled.tokens),
        messages: messages.map(m=>`${m}\n`).join(''), ok: true,
        info: { profile, inputs: ir.inputs, outputs: ir.outputs, constants: ir.constants } };
}

/**
 * An entry point given values for its uniform parameters, as an effect's `compile`
 * expression gives them: each bound parameter leaves the signature and becomes a local
 * of the body, initialised with its value -- so the value is checked, converted and
 * folded as any initialiser is. The parameters bound are those declared `uniform`, in
 * order; for an entry that declares none, those without a semantic.
 *
 * @param {import('./hlsl-parser.js').Program} program
 * @param {string} entry @param {import('./hlsl-parser.js').Expr[]} values
 * @returns {{ code: string, message: string, pos: any } | null}  The error, if any.
 */
function bindArguments(program, entry, values){
    const fn = program.decls.find(d=>d.kind === 'function' && d.name === entry && d.body
        && d.body.kind === 'block' && d.params.length >= values.length);
    if (!fn || fn.kind !== 'function' || !fn.body || fn.body.kind !== 'block')
    {
        // The compile itself says the entry point is not there.
        return null;
    }
    const uniform = fn.params.filter(p=>p.mods.includes('uniform'));
    const open = uniform.length > 0 ? uniform : fn.params.filter(p=>!p.semantic);
    if (values.length > open.length)
    {
        const count = values.length;
        return { code: 'X3013', message: `'${entry}': function does not take ${count} `
            + 'uniform parameters', pos: fn.pos };
    }
    const bound = open.slice(0, values.length);
    fn.params = fn.params.filter(p=>!bound.includes(p));
    fn.body.stmts.unshift({ kind: 'decl', pos: fn.body.pos, vars: bound.map((p, i)=>({
        ...p, mods: p.mods.filter(m=>m !== 'uniform' && m !== 'in'), semantic: null,
        register: null, init: structuredClone(values[i]) })) });
    return null;
}

/**
 * The CTAB block of a shader this compiler wrote, which it puts right after
 * the version token.
 *
 * @param {Uint32Array} tokens
 * @returns {Uint8Array | null}
 */
function constantTableOf(tokens){
    const token = tokens[1];
    if ((token & 0xffff) !== 0xfffe || tokens[2] !== 0x42415443)
    {
        return null;
    }
    const length = (token >>> 16) & 0x7fff;
    const words = tokens.slice(3, 2 + length);
    return new Uint8Array(words.buffer, words.byteOffset, words.byteLength).slice();
}
