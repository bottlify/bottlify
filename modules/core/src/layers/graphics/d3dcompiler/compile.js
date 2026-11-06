/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HLSL to a Direct3D 10 and 11 shader: the whole of D3DCompile for the profiles of Shader
 * Models 4 and 5.
 *
 * The front end is the Direct3D 9 compiler's (`win32/d3dx9`: the preprocessor, the parser,
 * the checker in its model 4 dialect, the lowering), the build and the back end this
 * folder's: values that know their bits (`sm4-build.js`), the program's objects where model 4
 * keeps them (`hlsl4.js`), registers and tokens and the container (`sm4-backend.js`).
 *
 * The code has the shape the lowering gives it: functions inlined, loops unrolled where their
 * count is known and run as `loop` where it is not, the arms of an `if` joined by `movc`.
 * What a model 4 program cannot be given here is refused by name: a geometry or compute
 * shader, a stream output, an unordered access view, a call through an interface.
 */

import { preprocessTracked } from '../../win32/d3dx9/preprocess.js';
import { HlslError, formatDiagnostic } from '../../win32/d3dx9/hlsl-lexer.js';
import { parse } from '../../win32/d3dx9/hlsl-parser.js';
import { check } from '../../win32/d3dx9/hlsl-check.js';
import { LowerError, lower } from '../../win32/d3dx9/hlsl-lower.js';
import { withLineMarkers } from '../../win32/d3dx9/hlsl-compile.js';
import { createSm4Builder, TargetError4 } from './sm4-build.js';
import { createTarget, layoutProgram } from './hlsl4.js';
import { BackendError, writeProgram } from './sm4-backend.js';
import { PROFILE_NAMES, profile4Of } from './sm4-ir.js';

/** D3DCOMPILE_* (D3D10_SHADER_*), the flags the compiler reads. */
export const D3DCOMPILE = Object.freeze({
    PACK_MATRIX_ROW_MAJOR: 1 << 3,
    PACK_MATRIX_COLUMN_MAJOR: 1 << 4,
    ENABLE_BACKWARDS_COMPATIBILITY: 1 << 12,
});

/**
 * @typedef {Object} Compile4Options
 * @property {string} profile
 * @property {string} [entry]      'main' when absent.
 * @property {number} [flags]
 * @property {[string, string][]} [defines]
 * @property {import('../../win32/d3dx9/preprocess.js').PreprocessOptions['include']} [include]
 * @property {import('../../win32/d3dx9/hlsl-parser.js').Expr[]} [arguments]
 *     An effect's `CompileShader(vs_4_0, main(...))` arguments for the uniform parameters.
 * @property {string} [source]     The name positions are printed with; 'memory' when absent.
 */

/**
 * @typedef {Object} Compile4Result
 * @property {boolean} ok
 * @property {Uint8Array | null} bytes   The container.
 * @property {string} messages   Errors and warnings, fxc's way, one to a line.
 */

/**
 * @param {string} source
 * @param {Compile4Options} options
 * @returns {Promise<Compile4Result>}
 */
export async function compileShader4(source, options){
    try
    {
        return await compile(source, options);
    }
    catch (e){
        return { ok: false, bytes: null, messages: `error X0000: internal compiler error: ${
            /** @type {Error} */ (e)?.stack ?? e}\n` };
    }
}

/** Whether a profile is one of this compiler's. @param {string} name */
export const isProfile4 = name=>profile4Of(name) !== null;

/**
 * @param {string} source
 * @param {Compile4Options} options
 * @returns {Promise<Compile4Result>}
 */
async function compile(source, options){
    /** @type {string[]} */
    const messages = [];
    /** @param {Parameters<typeof formatDiagnostic>[0]} d */
    const report = d=>{
        messages.push(d.code === 'X3501' ? `error X3501: ${d.message}` : formatDiagnostic(d));
    };
    const failed = ()=>({ ok: false, bytes: null, messages: messages.map(m=>`${m}\n`).join('') });
    const profile = profile4Of(options.profile);
    if (!profile)
    {
        messages.push(`error X3506: '${options.profile}': invalid compiler target; this compiler `
            + `targets ${PROFILE_NAMES.join(', ')}`);
        return failed();
    }
    if (profile.kind === 'gs' || profile.kind === 'cs')
    {
        messages.push(`error X3506: '${options.profile}': geometry and compute shaders are not `
            + 'compiled here yet');
        return failed();
    }
    const entryName = options.entry || 'main';
    const expanded = await preprocessTracked(source, { defines: options.defines,
        include: options.include });
    if ('error' in expanded)
    {
        messages.push(`${expanded.error.replace(/^([^:]*?)(\(\d+\))?: /, (_, file, line)=>
            `${file}${line ?? ''}: error X3000: `)}`);
        return failed();
    }
    let program;
    try
    {
        program = parse(withLineMarkers(expanded.text, expanded.origins), options.source);
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
        bindArguments(program, entryName, options.arguments);
    }
    const rowMajor = ((options.flags ?? 0) & D3DCOMPILE.PACK_MATRIX_ROW_MAJOR) !== 0;
    const { module, diagnostics } = check(program, { entry: entryName, rowMajor, sm4: true });
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
    /** @type {(code: string, message: string, pos: any) => never} */
    const fail = (code, message, pos)=>{
        throw new LowerError(code, message, pos);
    };
    let built;
    try
    {
        const layout = layoutProgram(program, module, entry, fail);
        const loops = new Set();
        for (;;)
        {
            const b = createSm4Builder(profile);
            const target = createTarget(b, profile, layout, module, fail);
            try
            {
                lower(module, entry, /** @type {any} */ (profile), { loops, target });
                built = { b, layout };
                break;
            }
            catch (e){
                if (!(e instanceof LowerError) || !e.loop || loops.has(e.loop))
                {
                    throw e;
                }
                loops.add(e.loop);
            }
        }
    }
    catch (e){
        if (!(e instanceof LowerError) && !(e instanceof TargetError4))
        {
            throw e;
        }
        report({ code: e.code, message: e.message,
            pos: (e instanceof LowerError ? e.pos : null) ?? entry.decl.pos });
        return failed();
    }
    const { b, layout } = built;
    try
    {
        const bytes = writeProgram({ profile, instrs: b.instrs, inputs: b.inputs,
            outputs: b.outputs, buffers: layout.buffers, resources: layout.resources,
            samplers: layout.samplers, vregCount: b.vregCount },
        { flags: options.flags ?? 0, entry: entryName });
        return { ok: true, bytes, messages: messages.map(m=>`${m}\n`).join('') };
    }
    catch (e){
        if (!(e instanceof BackendError))
        {
            throw e;
        }
        report({ code: e.code, message: e.message, pos: entry.decl.pos });
        return failed();
    }
}

/**
 * The values an effect's `CompileShader(profile, f(a, b))` gives the uniform parameters of
 * the entry: each leaves the signature and becomes a local initialised with it, as in the
 * Direct3D 9 compiler.
 *
 * @param {import('../../win32/d3dx9/hlsl-parser.js').Program} program
 * @param {string} entry @param {import('../../win32/d3dx9/hlsl-parser.js').Expr[]} values
 */
function bindArguments(program, entry, values){
    const fn = program.decls.find(d=>d.kind === 'function' && d.name === entry && d.body
        && d.body.kind === 'block' && d.params.length >= values.length);
    if (!fn || fn.kind !== 'function' || !fn.body || fn.body.kind !== 'block')
    {
        return;
    }
    const uniform = fn.params.filter(p=>p.mods.includes('uniform'));
    const open = uniform.length > 0 ? uniform : fn.params.filter(p=>!p.semantic);
    const bound = open.slice(0, values.length);
    fn.params = fn.params.filter(p=>!bound.includes(p));
    fn.body.stmts.unshift({ kind: 'decl', pos: fn.body.pos, vars: bound.map((p, i)=>({
        ...p, mods: p.mods.filter(m=>m !== 'uniform' && m !== 'in'), semantic: null,
        register: null, init: structuredClone(values[i]) })) });
}
