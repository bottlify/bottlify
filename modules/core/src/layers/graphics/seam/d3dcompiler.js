/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DCompiler_43.dll and D3DCOMPILER_47.dll, and the compiles of D3D10.dll: HLSL to a
 * Direct3D 10 or 11 shader (`graphics/d3dcompiler`), to a Direct3D 9 one for the model 2 and 3
 * profiles (`win32/d3dx9/hlsl-compile.js`), and to an fx_4_0 effect; the preprocessor alone;
 * and the functions over a compiled container - its parts, its signatures, a stripped copy,
 * an empty blob, a reflection.
 *
 * A compile answers as fxc does: S_OK and the code, or E_FAIL with no code; either way the
 * messages, one to a line, in the error blob when there are any. What is not compiled here is
 * a failed compile whose message says so, and a divergence.
 */

import { compileShader4, isProfile4 } from '../d3dcompiler/compile.js';
import { compileEffect, isEffectProfile } from '../d3dcompiler/fx-compile.js';
import { writeContainer } from '../d3dcompiler/dxbc-write.js';
import { compileShader } from '../../win32/d3dx9/hlsl-compile.js';
import { profileOf } from '../../win32/d3dx9/hlsl-ir.js';
import { preprocessTracked } from '../../win32/d3dx9/preprocess.js';
import { withLineMarkers } from '../../win32/d3dx9/hlsl-compile.js';
import { parseDxbc } from '../d3d10/dxbc.js';
import { D3DERR_INVALIDCALL } from '../d3d10/reflection.js';
import { E_FAIL, E_INVALIDARG, E_NOTIMPL, S_OK } from '../d3d10/constants.js';

/** D3D_BLOB_PART: the chunks each part is, and whether it comes as a container. */
const PARTS = /** @type {Record<number, { chunks: string[], container: boolean }>} */ ({
    0: { chunks: ['ISGN'], container: true },
    1: { chunks: ['OSGN'], container: true },
    2: { chunks: ['ISGN', 'OSGN'], container: true },
    3: { chunks: ['PCSG'], container: true },
    4: { chunks: ['ISGN', 'OSGN', 'PCSG'], container: true },
    5: { chunks: ['SDBG'], container: false },
    6: { chunks: ['Aon9'], container: false },
    7: { chunks: ['XNAP'], container: false },
    8: { chunks: ['XNAS'], container: false },
    9: { chunks: ['SPDB'], container: false },
    10: { chunks: ['PRIV'], container: false },
    11: { chunks: ['RTS0'], container: false },
    12: { chunks: ['ILDN'], container: false },
    // The test parts name chunks no compiler writes for a program.
    0x8000: { chunks: ['\u0000ALT'], container: false },
    0x8001: { chunks: ['\u0000DET'], container: false },
    0x8002: { chunks: ['\u0000PRF'], container: false },
});

/** D3DCOMPILER_STRIP_*: the chunks each flag takes out. */
const STRIPS = /** @type {[number, string[]][]} */ ([
    [1, ['RDEF', 'STAT']],
    [2, ['SDBG', 'SPDB']],
    [8, ['PRIV']],
    [16, ['RTS0']],
]);

/** The smallest container: its header and a chunk count. */
const HEADER = 32;

/**
 * @typedef {Object} CompilerDeps
 * @property {{ readU32: (at: number) => number, writeU32: (at: number, v: number) => void }} fields
 * @property {{ readMemory: (at: number, n: number) => Uint8Array,
 *     writeMemory: (at: number, b: Uint8Array) => void }} memory
 * @property {((size: number) => number) | undefined} allocate
 * @property {((at: number) => void) | undefined} free
 * @property {(detail: string) => void} report
 * @property {(out: number, bytes: Uint8Array | null, missing: number) => number} blobInto
 * @property {(address: number) => string} readCString
 * @property {((call: { entry: number, args: number[], thread?: any }) => Promise<number>)
 *     | undefined} callGuest
 * @property {(() => any) | undefined} currentThread
 * @property {(bytes: Uint8Array, riid: number, out: number) => number} reflect
 */

/**
 * @param {CompilerDeps} deps
 */
export function createCompilerSeam(deps){
    const { fields, memory, report, blobInto, readCString } = deps;

    /** @param {Uint8Array} bytes */
    const latin1 = bytes=>{
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x4000)
        {
            text += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
        }
        return text;
    };
    /** @param {string} text */
    const encode = text=>Uint8Array.from([...text].map(c=>c.charCodeAt(0) & 0xff).concat(0));

    /**
     * A D3D_SHADER_MACRO array: name and definition pointers to a null name.
     * @param {number} at @returns {[string, string][]}
     */
    const macrosAt = at=>{
        /** @type {[string, string][]} */
        const macros = [];
        for (let entry = at >>> 0; entry !== 0 && fields.readU32(entry) !== 0
            && macros.length < 1024; entry += 8)
        {
            const value = fields.readU32(entry + 4);
            macros.push([readCString(fields.readU32(entry)), value === 0 ? ''
                : readCString(value)]);
        }
        return macros;
    };

    /**
     * The program's ID3DInclude as the preprocessor's include: Open (its first slot; the
     * interface has no IUnknown) asked for the file with the data of the file that includes
     * it (NULL for the source itself), Close told once the file and everything it included
     * is read. The standard file
     * include, (ID3DInclude*)1, would read the program's files, which nothing here can.
     *
     * @param {string} api @param {number} include
     * @returns {(((name: string, system: boolean, parent: string) => Promise<string | null>)
     *     & { close: (name: string) => Promise<void> }) | undefined}
     */
    const includer = (api, include)=>{
        if ((include >>> 0) === 0)
        {
            return undefined;
        }
        if ((include >>> 0) === 1)
        {
            report(`${api}: D3D_COMPILE_STANDARD_FILE_INCLUDE is not available; an #include `
                + 'fails as a file not found');
            return undefined;
        }
        const thread = deps.currentThread?.();
        /**
         * The files open now, innermost last, each with the data Open gave:
         * a file's data is its includes' parent, and goes back by Close once
         * the file is read.
         *
         * @type {{ name: string, data: number }[]}
         */
        const open = [];
        const vtable = ()=>fields.readU32(include);
        /** @param {string} name @param {boolean} system @param {string} parent */
        const opened = async(name, system, parent)=>{
            const { allocate, free, callGuest } = deps;
            if (!allocate || !callGuest)
            {
                return null;
            }
            const scratch = allocate(name.length + 1 + 8);
            if (!scratch)
            {
                return null;
            }
            try
            {
                memory.writeMemory(scratch, encode(name));
                const dataOut = scratch + name.length + 1;
                fields.writeU32(dataOut, 0);
                fields.writeU32(dataOut + 4, 0);
                const from = [...open].reverse().find(file=>file.name === parent)?.data ?? 0;
                const answer = await callGuest({ entry: fields.readU32(vtable()),
                    args: [include, system ? 1 : 0, scratch, from, dataOut, dataOut + 4], thread });
                const data = fields.readU32(dataOut);
                if ((answer | 0) < 0 || data === 0)
                {
                    return null;
                }
                open.push({ name, data });
                return latin1(memory.readMemory(data, fields.readU32(dataOut + 4)));
            }
            finally
            {
                free?.(scratch);
            }
        };
        return Object.assign(opened, {
            /** @param {string} name */
            close: async name=>{
                const at = open.map(file=>file.name).lastIndexOf(name);
                if (at < 0 || !deps.callGuest)
                {
                    return;
                }
                const [file] = open.splice(at, 1);
                await deps.callGuest({ entry: fields.readU32(vtable() + 4),
                    args: [include, file.data], thread });
            },
        });
    };

    /** @param {number[]} outs */
    const clear = outs=>{
        for (const out of outs)
        {
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
        }
    };

    /**
     * The source a program passed: its bytes to the length it said, a trailing NUL dropped.
     * @param {number} data @param {number} size
     */
    const sourceOf = (data, size)=>{
        let text = latin1(memory.readMemory(data >>> 0, size >>> 0));
        const nul = text.indexOf('\u0000');
        if (nul >= 0)
        {
            text = text.slice(0, nul);
        }
        return text;
    };

    /**
     * One compile, whatever the profile.
     *
     * @param {string} api
     * @param {{ data: number, size: number, name: number, defines: number, include: number,
     *     entry: number, target: number, flags: number, effectFlags: number,
     *     codeOut: number, errorsOut: number }} call
     * @returns {Promise<number>}
     */
    const compileWork = async(api, call)=>{
        clear([call.codeOut, call.errorsOut]);
        if ((call.data >>> 0) === 0 || (call.target >>> 0) === 0 || (call.codeOut >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const text = sourceOf(call.data, call.size);
        const profile = readCString(call.target);
        const entry = (call.entry >>> 0) === 0 ? 'main' : readCString(call.entry);
        const source = (call.name >>> 0) === 0 ? undefined : readCString(call.name);
        const defines = macrosAt(call.defines);
        const include = includer(api, call.include);
        /** @type {{ ok: boolean, bytes: Uint8Array | null, messages: string }} */
        let result;
        if (isEffectProfile(profile))
        {
            result = await compileEffect(text, { profile, flags: call.flags,
                effectFlags: call.effectFlags, defines, include, source });
        }
        else if (isProfile4(profile))
        {
            result = await compileShader4(text, { profile, entry, flags: call.flags, defines,
                include, source });
        }
        else if (profileOf(profile))
        {
            // Model 2 and 3: the code is the Direct3D 9 token stream, its constant table in it.
            const nine = await compileShader(text, { profile, entry, flags: call.flags, defines,
                include });
            result = { ok: nine.ok, messages: nine.messages, bytes: nine.tokens
                ? new Uint8Array(nine.tokens.buffer, nine.tokens.byteOffset,
                    nine.tokens.byteLength) : null };
        }
        else
        {
            result = { ok: false, bytes: null, messages: `error X3506: '${profile}': `
                + 'invalid compiler target\n' };
        }
        if ((call.errorsOut >>> 0) !== 0 && result.messages !== '')
        {
            blobInto(call.errorsOut, encode(result.messages), E_FAIL);
        }
        if (!result.ok || !result.bytes)
        {
            const first = result.messages.split('\n').find(line=>/ error /.test(line))
                ?? result.messages.split('\n')[0];
            report(`${api}: refused ${profile} ${entry}: ${first}`);
            return E_FAIL;
        }
        return blobInto(call.codeOut, result.bytes, E_FAIL);
    };

    /**
     * The container of a program's bytes, the way the blob functions take it: a pointer or
     * a size that cannot be one is D3DERR_INVALIDCALL, bytes that do not hold a container
     * E_FAIL.
     *
     * @param {number} data @param {number} size
     * @returns {{ hr: number }
 *     | { bytes: Uint8Array, container: NonNullable<ReturnType<typeof parseDxbc>> }}
     */
    const containerAt = (data, size)=>{
        if ((data >>> 0) === 0 || (size >>> 0) < HEADER)
        {
            return { hr: D3DERR_INVALIDCALL };
        }
        const bytes = memory.readMemory(data >>> 0, size >>> 0);
        const container = parseDxbc(bytes);
        return container ? { bytes, container } : { hr: E_FAIL };
    };

    /**
     * A container of some of another's chunks, in their order there.
     * @param {NonNullable<ReturnType<typeof parseDxbc>>} container
     * @param {(name: string) => boolean} keep
     */
    const repacked = (container, keep)=>writeContainer([...container.chunks.entries()]
        .filter(([name])=>keep(name)).map(([name, bytes])=>({ name, bytes })));

    /** @param {string[]} chunks */
    const signatureEntry = chunks=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([data, size, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const found = containerAt(data, size);
            if ('hr' in found)
            {
                return found.hr;
            }
            if (chunks.some(name=>!found.container.chunks.has(name)))
            {
                return E_FAIL;
            }
            return blobInto(out, repacked(found.container, name=>chunks.includes(name)), E_FAIL);
        },
    });

    /**
     * HRESULT D3DCompile(LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO*, ID3DInclude*,
     *     LPCSTR, LPCSTR, UINT, UINT, ID3DBlob**, ID3DBlob**)
     */
    const D3DCompile = {
        argBytes: 44,
        /** @param {number[]} args */
        handler: ([data, size, name, defines, include, entry, target, flags, effectFlags,
            codeOut, errorsOut])=>compileWork('D3DCompile', { data, size, name, defines,
            include, entry, target, flags, effectFlags, codeOut, errorsOut }),
    };

    const exports = {
        D3DCompile,
        /**
         * HRESULT D3DCompile2(LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO*, ID3DInclude*,
         *     LPCSTR, LPCSTR, UINT, UINT, UINT, LPCVOID, SIZE_T, ID3DBlob**, ID3DBlob**)
         * The secondary data (a library to link, a merged UAV slot) is not taken.
         */
        D3DCompile2: {
            argBytes: 56,
            /** @param {number[]} args */
            handler: ([data, size, name, defines, include, entry, target, flags, effectFlags,
                secondaryFlags, secondary, , codeOut, errorsOut])=>{
                if ((secondaryFlags >>> 0) !== 0 || (secondary >>> 0) !== 0)
                {
                    report('D3DCompile2: secondary data is not taken; compiled without it');
                }
                return compileWork('D3DCompile2', { data, size, name, defines, include, entry,
                    target, flags, effectFlags, codeOut, errorsOut });
            },
        },
        /**
         * HRESULT D3DPreprocess(LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO*,
         *     ID3DInclude*, ID3DBlob**, ID3DBlob**)
         */
        D3DPreprocess: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: async([data, size, name, defines, include, textOut, errorsOut])=>{
                clear([textOut, errorsOut]);
                if ((data >>> 0) === 0 || (textOut >>> 0) === 0)
                {
                    return E_FAIL;
                }
                const expanded = await preprocessTracked(sourceOf(data, size), {
                    defines: macrosAt(defines), include: includer('D3DPreprocess', include) });
                if ('error' in expanded)
                {
                    if ((errorsOut >>> 0) !== 0)
                    {
                        blobInto(errorsOut, encode(`${expanded.error}\n`), E_FAIL);
                    }
                    report(`D3DPreprocess: refused: ${expanded.error}`);
                    return E_FAIL;
                }
                void name;
                return blobInto(textOut, encode(withLineMarkers(expanded.text,
                    expanded.origins)), E_FAIL);
            },
        },
        /** HRESULT D3DCreateBlob(SIZE_T, ID3DBlob**) */
        D3DCreateBlob: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, out])=>((out >>> 0) === 0 ? D3DERR_INVALIDCALL
                : blobInto(out, new Uint8Array(size >>> 0), E_FAIL)),
        },
        /** HRESULT D3DGetBlobPart(LPCVOID, SIZE_T, D3D_BLOB_PART, UINT, ID3DBlob**) */
        D3DGetBlobPart: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([data, size, part, flags, out])=>{
                const which = PARTS[part >>> 0];
                if ((out >>> 0) === 0 || (flags >>> 0) !== 0 || !which)
                {
                    return D3DERR_INVALIDCALL;
                }
                const found = containerAt(data, size);
                if ('hr' in found)
                {
                    return found.hr;
                }
                const { container } = found;
                if (which.chunks.some(name=>!container.chunks.has(name)))
                {
                    return E_FAIL;
                }
                return blobInto(out, which.container
                    ? repacked(container, name=>which.chunks.includes(name))
                    : /** @type {Uint8Array} */ (container.chunks.get(which.chunks[0])).slice(),
                E_FAIL);
            },
        },
        /** HRESULT D3DGetInputSignatureBlob(LPCVOID, SIZE_T, ID3DBlob**) */
        D3DGetInputSignatureBlob: signatureEntry(['ISGN']),
        /** HRESULT D3DGetOutputSignatureBlob(LPCVOID, SIZE_T, ID3DBlob**) */
        D3DGetOutputSignatureBlob: signatureEntry(['OSGN']),
        /** HRESULT D3DGetInputAndOutputSignatureBlob(LPCVOID, SIZE_T, ID3DBlob**) */
        D3DGetInputAndOutputSignatureBlob: signatureEntry(['ISGN', 'OSGN']),
        /** HRESULT D3DStripShader(LPCVOID, SIZE_T, UINT, ID3DBlob**) */
        D3DStripShader: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([data, size, strip, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_FAIL;
                }
                const found = containerAt(data, size);
                if ('hr' in found)
                {
                    return found.hr;
                }
                const gone = new Set(STRIPS.filter(([flag])=>((strip >>> 0) & flag) !== 0)
                    .flatMap(([, names])=>names));
                return blobInto(out, repacked(found.container, name=>!gone.has(name)), E_FAIL);
            },
        },
        /** HRESULT D3DDisassemble(LPCVOID, SIZE_T, UINT, LPCSTR, ID3DBlob**) */
        D3DDisassemble: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, , , , out])=>{
                clear([out]);
                report('D3DDisassemble: no disassembler is kept here');
                return E_NOTIMPL;
            },
        },
        /** HRESULT D3DReflect(LPCVOID, SIZE_T, REFIID, void**) */
        D3DReflect: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([data, size, riid, out])=>{
                if ((data >>> 0) === 0 || (out >>> 0) === 0 || (size >>> 0) === 0)
                {
                    return 0x80070057 | 0;
                }
                return deps.reflect(memory.readMemory(data >>> 0, size >>> 0), riid, out);
            },
        },
    };

    /**
     * HRESULT D3D10CompileShader(LPCSTR, SIZE_T, LPCSTR, const D3D10_SHADER_MACRO*,
     *     LPD3D10INCLUDE, LPCSTR, LPCSTR, UINT, ID3D10Blob**, ID3D10Blob**)
     */
    const D3D10CompileShader = {
        argBytes: 40,
        /** @param {number[]} args */
        handler: ([data, size, name, defines, include, entry, target, flags, codeOut,
            errorsOut])=>compileWork('D3D10CompileShader', { data, size, name, defines, include,
            entry, target, flags, effectFlags: 0, codeOut, errorsOut }),
    };

    /**
     * HRESULT D3D10CompileEffectFromMemory(void*, SIZE_T, LPCSTR, const D3D10_SHADER_MACRO*,
     *     ID3D10Include*, UINT HLSLFlags, UINT FXFlags, ID3D10Blob**, ID3D10Blob**)
     */
    const D3D10CompileEffectFromMemory = {
        argBytes: 36,
        /** @param {number[]} args */
        handler: async([data, size, name, defines, include, flags, effectFlags, codeOut,
            errorsOut])=>{
            if ((data >>> 0) === 0 || (codeOut >>> 0) === 0)
            {
                clear([codeOut, errorsOut]);
                return E_FAIL;
            }
            const target = deps.allocate?.(8) ?? 0;
            if (!target)
            {
                return E_FAIL;
            }
            memory.writeMemory(target, encode('fx_4_0'));
            try
            {
                return await compileWork('D3D10CompileEffectFromMemory', { data, size, name,
                    defines, include, entry: 0, target, flags, effectFlags, codeOut, errorsOut });
            }
            finally
            {
                deps.free?.(target);
            }
        },
    };

    return { exports, D3D10CompileShader, D3D10CompileEffectFromMemory, S_OK };
}
