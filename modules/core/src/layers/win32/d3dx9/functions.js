/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9 — the maths half of the Direct3D helper library.
 *
 * These are the functions a program links from d3dx9 that touch no device:
 * matrix and vector arithmetic over the caller's own memory. They matter here
 * for a reason that has nothing to do with drawing: d3dx9 exports every one of
 * them by an *undecorated* name, though each is `__stdcall`. An import bound to
 * a stub that pops nothing then leaves the caller's stack short by the width of
 * the arguments -- and a program that calls one during start-up walks off into
 * data a few frames later and faults on the first byte it tries to run. So the
 * whole of this file's contract is the byte counts; the maths is here because
 * once the count is right the maths is a few lines and a program that transposes
 * a matrix expects the transpose.
 *
 * The ones that build something on a device go through the program's own
 * device's methods: a texture from an image file (`texture.js`), an effect
 * (`effect.js`). Those not built yet -- a mesh, a shape -- answer E_NOTIMPL with
 * the argument width still declared, their out-pointers null, and say so where
 * divergences are told.
 *
 * Matrices are row-major, sixteen floats, `m[row * 4 + col]` -- the layout
 * D3DXMATRIX has in memory and the one every function here reads and writes.
 * The arithmetic is code in the guest's own d3dx9 (`inguest.js`,
 * `inguest-matrix.js`, `inguest-vector.js`, `inguest-quaternion.js`),
 * compiled from its JavaScript: a program that multiplies its matrices every
 * frame pays for the x87's instructions, not a crossing into the host. Every
 * function each of those modules compiles is an export, and the table is the
 * same for every version of the library from d3dx9_24 to d3dx9_43, whose
 * mathematics does not differ.
 */

import { createFonts } from './font.js';
import { createSprites } from './sprite.js';
import { createLines } from './line.js';
import { createRenderToSurface } from './render-to-surface.js';
import { createEffects } from './effect.js';
import { createTextureLoader } from './texture.js';
import { createTextureTools } from './texture-tools.js';
import { createTextureSaver } from './save-texture.js';
import { guestEntry } from '../msvcrt/guest-code.js';
import { createComObject } from '../ole32/objects.js';
import { createConstantTableObjects } from './constants.js';
import { createShaderSemantics } from './semantics.js';
import { createMeshFunctions } from './mesh.js';
import { preprocess, preprocessTracked } from './preprocess.js';
import { compileShader } from './hlsl-compile.js';
import { assembleShader, disassembleShader } from './shader-asm.js';
import * as inGuest from './inguest.js';
import * as matrix from './inguest-matrix.js';
import * as vector from './inguest-vector.js';
import * as quaternion from './inguest-quaternion.js';
import { COMPILED } from './inguest.x86.js';
import { COMPILED as MATRIX } from './inguest-matrix.x86.js';
import { COMPILED as VECTOR } from './inguest-vector.x86.js';
import { COMPILED as QUATERNION } from './inguest-quaternion.x86.js';

const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
const E_FAIL = 0x80004005;
const D3DERR_INVALIDCALL = 0x8876086c;
const IID_ID3DXBUFFER = '{8BA5FB08-5195-40E2-AC58-0D989C3A0102}';

/**
 * What an image file is, by its signature, as D3DX's loaders tell them apart.
 *
 * @param {Uint8Array} head  Its first four bytes.
 * @returns {string}
 */
function imageKind(head){
    const text = String.fromCharCode(...head);
    if (text === 'DDS ')
    {
        return 'DDS';
    }
    if (text.startsWith('BM'))
    {
        return 'BMP';
    }
    if (head[0] === 0xff && head[1] === 0xd8)
    {
        return 'JPEG';
    }
    if (text === 'PNG')
    {
        return 'PNG';
    }
    const bytes = [...head].map(b=>b.toString(16).padStart(2, '0')).join(' ');
    return `unrecognised, perhaps TGA: ${bytes}`;
}

/**
 * The facilities this surface does not build: each one's argument width, in
 * bytes, then which of its arguments are out-pointers it leaves null -- a
 * caller that does not check the answer finds no object rather than whatever
 * its variable held. Widths are the documented signatures'.
 *
 * @type {Record<string, number[]>}
 */
const NOT_BUILT = {
    D3DXAssembleShaderFromFileA: [24, 4, 5],
    D3DXCleanMesh: [24, 3, 5],
    D3DXComputeNormalMap: [24],
    D3DXCreateBox: [24, 4, 5],
    D3DXCreateCylinder: [32, 6, 7],
    D3DXCreateMesh: [24, 5],
    D3DXCreateMeshFVF: [24, 5],
    D3DXCreatePolygon: [20, 3, 4],
    D3DXCreateSphere: [24, 4, 5],
    D3DXCreateTeapot: [12, 1, 2],
    D3DXCreateTextA: [32, 5, 6],
    D3DXCreateTorus: [28, 5, 6],
    D3DXSaveSurfaceToFileA: [20],
    D3DXSaveSurfaceToFileInMemory: [20, 0],
    D3DXSimplifyMesh: [28, 6],
    D3DXUVAtlasPartition: [68, 11, 12, 13, 14],
    D3DXValidMesh: [12, 2],
};


/**
 * Each module of guest code and what the build made of it: every function
 * compiled is exported under its own name.
 *
 * @type {[Record<string, any>, Record<string, import('../msvcrt/guest-code.js').CompiledGuestCode>][]}
 */
const IN_GUEST = [[inGuest, COMPILED], [matrix, MATRIX], [vector, VECTOR],
    [quaternion, QUATERNION]];

/**
 * @typedef {Object} D3dxHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 *           Where a COM object gets the interface pointer a program holds.
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any,
 *     allocateCode?: (bytes: number) => number }} [heap]
 *           Where code goes too: the slots of a COM method that answers a FLOAT.
 * @property {(call: { entry: number, args: number[], thread?: any })
 *     => Promise<number>} [callGuest]
 *           A call into the guest -- a device's own method, from a constant table's setter.
 * @property {() => any} [currentThread]
 *           Whose call is in flight: a call into the guest made after an await names it.
 * @property {(font: any) => any} [fontMetrics]
 *           What the font engine GDI draws with measures for a font, or null.
 * @property {(code: number, font: any) => any} [glyph]
 *           One character's coverage from that engine, or null.
 * @property {(record: { api: string, profile: string, entry: string,
 *     defines: [string, string][], flags: number, source: string,
 *     included: Record<string, string>, messages: string, tokens: Uint32Array | null })
 *     => void} [shaderCompiled]
 *           Told of each compile, for a tool that compares the source with what came out.
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 *           A file's bytes, for D3DXCreateEffectFromFile and its kin.
 * @property {(path: string, bytes: Uint8Array) => Promise<boolean> | boolean} [writeFile]
 *           A file written whole, for D3DXSaveTextureToFile: false when it could not be.
 * @property {(module: number, name: string | number, type: number) =>
 *     Promise<Uint8Array | null> | Uint8Array | null} [resource]
 *           A module's resource, for D3DXCreateEffectFromResource and its kin.
 */

/**
 * @param {D3dxHost} host
 * @param {{ version?: number }} [options]  The d3dx9 version the table is for (24 to 43):
 *     the layout of ID3DXEffect changed at 26 and 27. The latest when absent.
 */
export function createD3dxFunctions(host, options = {}){
    const textures = createTextureLoader(host);
    const sprites = createSprites(host);
    const fonts = createFonts(host, sprites);
    const polylines = createLines(host);
    const renderTargets = createRenderToSurface(host, textures);
    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const buffer = {
        id: IID_ID3DXBUFFER,
        methods: [
            /** LPVOID GetBufferPointer() */
            { name: 'GetBufferPointer', argBytes: 4, invoke: object=>object.state.data },
            /** DWORD GetBufferSize() */
            { name: 'GetBufferSize', argBytes: 4, invoke: object=>object.state.size },
        ],
    };

    /** @param {Uint8Array} bytes */
    const latin1 = bytes=>{
        let text = '';
        for (let at = 0; at < bytes.length; at += 8192)
        {
            text += String.fromCharCode(...bytes.subarray(at, at + 8192));
        }
        return text;
    };
    /** Text as the bytes D3DX hands back: one a character, then a NUL. @param {string} text */
    const encode = text=>Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0) & 0xff);
    /** @param {number} address */
    const u32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** A NUL-ended string's bytes, at most 4 KB of them. @param {number} address */
    const cString = address=>{
        const bytes = host.readMemory(address >>> 0, 4096);
        const end = bytes.indexOf(0);
        return bytes.slice(0, end < 0 ? bytes.length : end);
    };
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>host.writeMemory(at >>> 0, Uint8Array.of(value & 0xff,
        value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24));

    /**
     * An ID3DXBuffer holding these bytes, its pointer written to `out`.
     *
     * @param {number} out @param {Uint8Array} bytes
     * @returns {number}  An HRESULT.
     */
    const giveBuffer = (out, bytes)=>{
        const heap = /** @type {NonNullable<D3dxHost['heap']>} */ (host.heap);
        const vtables = /** @type {NonNullable<D3dxHost['vtables']>} */ (host.vtables);
        const size = bytes.length;
        const data = heap.allocate(Math.max(size, 1));
        if (data === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(data, bytes);
        const object = createComObject(IID_ID3DXBUFFER, { interfaces: [buffer],
            state: { data, size }, destroy: ()=>heap.free(data) });
        const pointer = vtables.publish(object, IID_ID3DXBUFFER) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        putU32(out, pointer);
        return 0;
    };

    /**
     * A font as D3DXCreateFont's arguments describe it.
     *
     * @param {number[]} args @param {boolean} isWide
     */
    const createFont = (args, isWide)=>{
        const [device, height, width, weight, mips, italic, charSet, precision, quality, pitch,
            face, out] = args;
        if ((out >>> 0) !== 0)
        {
            putU32(out, 0);
        }
        if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.vtables)
        {
            return D3DERR_INVALIDCALL;
        }
        return fonts.create(device, { height: height | 0, width: width >>> 0,
            weight: weight >>> 0, mipLevels: mips >>> 0, italic: italic ? 1 : 0,
            charSet: charSet & 0xff, outputPrecision: precision & 0xff, quality: quality & 0xff,
            pitchAndFamily: pitch & 0xff, faceName: faceNameAt(face, isWide) }, out);
    };

    /**
     * A font as a D3DXFONT_DESC describes it.
     *
     * @param {number[]} args @param {boolean} isWide
     */
    const createFontIndirect = ([device, desc, out], isWide)=>{
        if ((desc >>> 0) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        const bytes = host.readMemory(desc >>> 0, 24);
        const view = new DataView(bytes.slice().buffer);
        return createFont([device, view.getInt32(0, true), view.getUint32(4, true),
            view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true),
            bytes[20], bytes[21], bytes[22], bytes[23], (desc >>> 0) + 24, out], isWide);
    };

    /** A face name, at most 31 characters. @param {number} at @param {boolean} isWide */
    const faceNameAt = (at, isWide)=>{
        if ((at >>> 0) === 0)
        {
            return '';
        }
        if (!isWide)
        {
            return latin1(cString(at)).slice(0, 31);
        }
        const units = new Uint16Array(host.readMemory(at >>> 0, 64).slice().buffer);
        const end = units.indexOf(0);
        return String.fromCharCode(...units.subarray(0, end < 0 ? 32 : end)).slice(0, 31);
    };

    /**
     * A D3DXMACRO array: name and definition pointers, until a null name.
     *
     * @param {number} at
     * @returns {[string, string][]}
     */
    const macrosAt = at=>{
        /** @type {[string, string][]} */
        const macros = [];
        for (let entry = at >>> 0; entry !== 0 && u32(entry) !== 0 && macros.length < 1024;
            entry += 8)
        {
            const value = u32(entry + 4);
            macros.push([latin1(cString(u32(entry))), value === 0 ? '' : latin1(cString(value))]);
        }
        return macros;
    };

    /**
     * The program's ID3DXInclude as the preprocessor's include: Open (its
     * first slot -- the interface has no IUnknown) asked for the file, the
     * text read from what it hands back, and Close (the second) told.
     *
     * @param {number} include
     */
    const includer = include=>{
        // The thread whose call this answers, taken now: the calls into the
        // guest below come after an await, when another may be running.
        const thread = host.currentThread?.();
        return (/** @type {string} */ name, /** @type {boolean} */ system)=>
            open(include, thread, name, system);
    };

    /**
     * @param {number} include @param {any} thread @param {string} name @param {boolean} system
     * @returns {Promise<string | null>}
     */
    const open = async(include, thread, name, system)=>{
        const { heap, callGuest } = host;
        if (!heap || !callGuest)
        {
            return null;
        }
        const scratch = heap.allocate(name.length + 1 + 8);
        if (scratch === 0)
        {
            return null;
        }
        try
        {
            host.writeMemory(scratch, encode(name));
            const dataOut = scratch + name.length + 1;
            putU32(dataOut, 0);
            putU32(dataOut + 4, 0);
            const vtable = u32(include);
            const answer = await callGuest({ entry: u32(vtable), args: [include, system ? 1 : 0,
                scratch, 0, dataOut, dataOut + 4], thread });
            const data = u32(dataOut);
            if ((answer | 0) < 0 || data === 0)
            {
                return null;
            }
            const text = latin1(host.readMemory(data, u32(dataOut + 4)).slice());
            await callGuest({ entry: u32(vtable + 4), args: [include, data], thread });
            return text;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    const constantTables = createConstantTableObjects(host);
    const effects = createEffects(host, { giveBuffer, macrosAt,
        includer: include=>includer(include),
        publishConstantTable: (block, version, out)=>constantTables.publish(block, version, out) },
    { version: options.version });

    /**
     * Compiles already done, by source, entry, profile, flags and macros, each with the files
     * it included: a program that asks for the same compile again -- every frame, as some do
     * after a refusal -- is given the same answer once its includes are found the same.
     *
     * @type {Map<string, { included: { name: string, system: boolean, text: string }[],
     *     result: Awaited<ReturnType<typeof compileShader>> }>}
     */
    const compiles = new Map();
    /** The most compiles kept; the oldest goes first. */
    const COMPILES_KEPT = 512;

    return {
        ...Object.fromEntries(IN_GUEST.flatMap(([source, compiled])=>Object.keys(compiled)
            .map(name=>[name, guestEntry(source[name], compiled[name], host)]))),

        ...constantTables.exports,

        /** See semantics.js. */
        ...createShaderSemantics(host),

        /** See mesh.js. */
        ...createMeshFunctions(host),

        /** See texture-tools.js. */
        ...createTextureTools(host),

        /** See save-texture.js. */
        ...createTextureSaver(host, { giveBuffer }),

        /** See effect.js. */
        ...effects.exports,

        ...Object.fromEntries(Object.entries(NOT_BUILT).map(([name, [argBytes, ...outs]])=>[name, {
            argBytes,
            /** @param {number[]} args */
            handler: args=>{
                for (const at of outs)
                {
                    if ((args[at] >>> 0) !== 0)
                    {
                        host.writeMemory(args[at] >>> 0, new Uint8Array(4));
                    }
                }
                // An image named by what it is, so a report says which decoders a
                // program wants: the first bytes of the data it handed over.
                const dataAt = args[name.endsWith('InMemoryEx') ? 1 : 0] >>> 0;
                const image = name.endsWith('InMemoryEx') || name.endsWith('FileInMemory')
                    ? ` (${imageKind(host.readMemory(dataAt, 4))})`
                    : '';
                host.divergence?.(name,
                    `answered E_NOTIMPL: nothing is built on a device here${image}`);
                return E_NOTIMPL;
            },
        }])),

        /** See texture.js. */
        ...textures.exports,

        /** HRESULT D3DXCreateSprite(LPDIRECT3DDEVICE9 pDevice, LPD3DXSPRITE *ppSprite) */
        D3DXCreateSprite: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([device, out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32(out, 0);
                }
                if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.vtables)
                {
                    return D3DERR_INVALIDCALL;
                }
                const { pointer } = sprites.create(device);
                if (pointer === 0)
                {
                    return E_OUTOFMEMORY;
                }
                putU32(out, pointer);
                return 0;
            },
        },

        /** See line.js. */
        D3DXCreateLine: { argBytes: 8, handler: polylines.create },
        /** See render-to-surface.js. */
        D3DXCreateRenderToSurface: { argBytes: 28, handler: renderTargets.create },

        /**
         * HRESULT D3DXCreateFontA(LPDIRECT3DDEVICE9 pDevice, INT Height, UINT Width,
         *     UINT Weight, UINT MipLevels, BOOL Italic, DWORD CharSet, DWORD OutputPrecision,
         *     DWORD Quality, DWORD PitchAndFamily, LPCSTR pFaceName, LPD3DXFONT *ppFont)
         */
        D3DXCreateFontA: { argBytes: 48,
            handler: (/** @type {number[]} */ args)=>createFont(args, false) },
        /** The same, the face name wide. */
        D3DXCreateFontW: { argBytes: 48,
            handler: (/** @type {number[]} */ args)=>createFont(args, true) },
        /**
         * HRESULT D3DXCreateFontIndirectA(LPDIRECT3DDEVICE9 pDevice,
         *     CONST D3DXFONT_DESCA *pDesc, LPD3DXFONT *ppFont)
         */
        D3DXCreateFontIndirectA: { argBytes: 12, handler: (/** @type {number[]} */ args)=>
            createFontIndirect(args, false) },
        /** The same, D3DXFONT_DESCW. */
        D3DXCreateFontIndirectW: { argBytes: 12, handler: (/** @type {number[]} */ args)=>
            createFontIndirect(args, true) },

        /**
         * HRESULT D3DXCreateBuffer(DWORD NumBytes, LPD3DXBUFFER *ppBuffer)
         *
         * An ID3DXBuffer over a block of that many bytes, zeroed, which goes
         * back to the heap with the last Release. A program fills one with
         * what it hands a shader or an effect, and does not check the answer
         * before it writes.
         */
        D3DXCreateBuffer: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([bytes, out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                host.writeMemory(out >>> 0, new Uint8Array(4));
                if (!host.heap || !host.vtables)
                {
                    return E_NOTIMPL;
                }
                return giveBuffer(out, new Uint8Array(bytes >>> 0));
            },
        },

        /**
         * HRESULT D3DXPreprocessShader(LPCSTR pSrcData, UINT SrcDataSize,
         *     const D3DXMACRO *pDefines, LPD3DXINCLUDE pInclude,
         *     LPD3DXBUFFER *ppShaderText, LPD3DXBUFFER *ppErrorMsgs)
         *
         * The source run through the preprocessor (`preprocess.js`), with the
         * program's macros and its ID3DXInclude for every #include, handed
         * back as a buffer of text ended by a NUL; a directive that fails
         * answers E_FAIL with its message in the error buffer.
         */
        D3DXPreprocessShader: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([source, size, defines, include, textOut, errorsOut])=>{
                for (const out of [textOut, errorsOut])
                {
                    if ((out >>> 0) !== 0)
                    {
                        host.writeMemory(out >>> 0, new Uint8Array(4));
                    }
                }
                if ((source >>> 0) === 0 || !host.heap || !host.vtables)
                {
                    return D3DERR_INVALIDCALL;
                }
                const text = latin1(host.readMemory(source >>> 0, size >>> 0));
                return preprocess(text, { defines: macrosAt(defines),
                    include: (include >>> 0) === 0 ? undefined : includer(include >>> 0) })
                    .then(result=>{
                        if ('error' in result)
                        {
                            if ((errorsOut >>> 0) !== 0)
                            {
                                giveBuffer(errorsOut, encode(`${result.error}\n`));
                            }
                            return E_FAIL;
                        }
                        return (textOut >>> 0) === 0 ? 0 : giveBuffer(textOut, encode(result.text));
                    });
            },
        },

        /**
         * HRESULT D3DXCompileShader(LPCSTR pSrcData, UINT SrcDataLen, const D3DXMACRO*,
         *     LPD3DXINCLUDE, LPCSTR pFunctionName, LPCSTR pProfile, DWORD Flags,
         *     LPD3DXBUFFER *ppShader, LPD3DXBUFFER *ppErrorMsgs,
         *     LPD3DXCONSTANTTABLE *ppConstantTable)
         *
         * The HLSL compiler (`hlsl-compile.js`): the source through the
         * preprocessor with the program's macros and its ID3DXInclude, to the
         * bytecode of the entry point for the profile, and its constant table.
         * What was found wrong -- and any warning, for a compile that went
         * through -- is text in the error buffer, `file(line,col): error
         * Xnnnn: ...` as fxc prints it; a compile with errors answers E_FAIL
         * and leaves the shader and the table null.
         */
        D3DXCompileShader: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([source, size, defines, include, entry, profile, flags, shaderOut,
                errorsOut, tableOut])=>{
                for (const out of [shaderOut, errorsOut, tableOut])
                {
                    if ((out >>> 0) !== 0)
                    {
                        host.writeMemory(out >>> 0, new Uint8Array(4));
                    }
                }
                if ((source >>> 0) === 0 || (profile >>> 0) === 0 || (shaderOut >>> 0) === 0
                    || !host.heap || !host.vtables)
                {
                    return D3DERR_INVALIDCALL;
                }
                const text = latin1(host.readMemory(source >>> 0, size >>> 0));
                const macros = macrosAt(defines);
                /** What the program's ID3DXInclude handed over, by name, for the record. */
                /** @type {Record<string, string>} */
                const included = {};
                /** @type {{ name: string, system: boolean, text: string }[]} */
                const opened = [];
                const opener = (include >>> 0) === 0 ? undefined : includer(include >>> 0);
                /** @param {string} name @param {boolean} system */
                const recorded = async(name, system)=>{
                    const file = await /** @type {NonNullable<typeof opener>} */ (opener)(name,
                        system);
                    if (file !== null)
                    {
                        included[name] = file;
                        opened.push({ name, system, text: file });
                    }
                    return file;
                };
                const entryName = (entry >>> 0) === 0 ? 'main' : latin1(cString(entry));
                const key = JSON.stringify([text, entryName, latin1(cString(profile)),
                    flags >>> 0, macros, (include >>> 0) !== 0]);
                /** The answer of an earlier compile, if its includes are still the same. */
                const earlier = async()=>{
                    const known = compiles.get(key);
                    if (!known)
                    {
                        return null;
                    }
                    for (const file of known.included)
                    {
                        if (await recorded(file.name, file.system) !== file.text)
                        {
                            return null;
                        }
                    }
                    return known.result;
                };
                return earlier().then(async known=>{
                    if (known)
                    {
                        return known;
                    }
                    Object.keys(included).forEach(name=>delete included[name]);
                    opened.length = 0;
                    const result = await compileShader(text, {
                        entry: entryName,
                        profile: latin1(cString(profile)),
                        flags: flags >>> 0,
                        defines: macros,
                        include: opener && recorded,
                    });
                    compiles.delete(key);
                    compiles.set(key, { included: opened.slice(), result });
                    if (compiles.size > COMPILES_KEPT)
                    {
                        compiles.delete(/** @type {string} */ (compiles.keys().next().value));
                    }
                    return result;
                }).then(result=>{
                    host.shaderCompiled?.({ api: 'D3DXCompileShader',
                        profile: latin1(cString(profile)),
                        entry: entryName,
                        defines: macros, flags: flags >>> 0, source: text, included,
                        messages: result.messages, tokens: result.tokens });
                    if ((errorsOut >>> 0) !== 0 && result.messages !== '')
                    {
                        giveBuffer(errorsOut, encode(result.messages));
                    }
                    if (!result.ok || !result.tokens)
                    {
                        // The line it points at, so a report says what the program
                        // wrote and not only where.
                        const lines = result.messages.split('\n');
                        const first = lines.find(line=>/ error /.test(line)) ?? lines[0];
                        const at = /^memory\((\d+),/.exec(first);
                        const line = at ? text.split('\n')[Number(at[1]) - 1]?.trim() : undefined;
                        host.divergence?.('D3DXCompileShader', `refused: ${first}${
                            line ? ` -- ${line}` : ''}`);
                        return E_FAIL;
                    }
                    const bytes = new Uint8Array(result.tokens.buffer, result.tokens.byteOffset,
                        result.tokens.byteLength);
                    const answer = giveBuffer(shaderOut, bytes);
                    if (answer !== 0 || (tableOut >>> 0) === 0 || !result.constantTable)
                    {
                        return answer;
                    }
                    return constantTables.publish(result.constantTable, result.tokens[0], tableOut);
                });
            },
        },

        /**
         * HRESULT D3DXAssembleShader(LPCSTR pSrcData, UINT SrcDataLen,
         *     const D3DXMACRO *pDefines, LPD3DXINCLUDE pInclude, DWORD Flags,
         *     LPD3DXBUFFER *ppShader, LPD3DXBUFFER *ppErrorMsgs)
         *
         * Shader assembly (`shader-asm.js`) to bytecode, after the preprocessor
         * has had the program's macros and includes. A line that does not assemble
         * is `file(line): error: text` in the error buffer, the line being the one
         * of the file it came from; any such line answers E_FAIL with no shader.
         */
        D3DXAssembleShader: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([source, size, defines, include, , shaderOut, errorsOut])=>{
                for (const out of [shaderOut, errorsOut])
                {
                    if ((out >>> 0) !== 0)
                    {
                        host.writeMemory(out >>> 0, new Uint8Array(4));
                    }
                }
                if ((source >>> 0) === 0 || (shaderOut >>> 0) === 0 || !host.heap
                    || !host.vtables)
                {
                    return D3DERR_INVALIDCALL;
                }
                const text = latin1(host.readMemory(source >>> 0, size >>> 0));
                return preprocessTracked(text, { defines: macrosAt(defines),
                    include: (include >>> 0) === 0 ? undefined : includer(include >>> 0) })
                    .then(expanded=>{
                        /** @type {string[]} */
                        const messages = [];
                        let tokens = null;
                        if ('error' in expanded)
                        {
                            messages.push(`${expanded.error}\n`);
                        }
                        else
                        {
                            const result = assembleShader(expanded.text);
                            tokens = result.tokens;
                            for (const { line, message } of result.errors)
                            {
                                const origin = expanded.origins[line - 1];
                                messages.push(`${origin?.file ?? 'memory'}(${origin?.line ?? line}`
                                    + `): error: ${message}\n`);
                            }
                        }
                        if (messages.length > 0 && (errorsOut >>> 0) !== 0)
                        {
                            giveBuffer(errorsOut, encode(messages.join('')));
                        }
                        if (messages.length > 0 || !tokens)
                        {
                            host.divergence?.('D3DXAssembleShader', `refused: ${
                                messages[0]?.trim()}`);
                            return E_FAIL;
                        }
                        return giveBuffer(shaderOut, new Uint8Array(tokens.buffer,
                            tokens.byteOffset, tokens.byteLength));
                    });
            },
        },

        /**
         * HRESULT D3DXDisassembleShader(const DWORD *pShader, BOOL EnableColorCode,
         *     LPCSTR pComments, LPD3DXBUFFER *ppDisassembly)
         *
         * The listing of a shader (`shader-asm.js`) as text in a buffer, the
         * comment the program gave first. The colour codes are not written: they
         * are HTML-like markup for a viewer, and a program that asks for them
         * gets the plain text. Bytecode that is not a shader answers
         * D3DERR_INVALIDCALL.
         */
        D3DXDisassembleShader: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([shader, , comments, out])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(4));
                }
                if ((shader >>> 0) === 0 || (out >>> 0) === 0 || !host.heap || !host.vtables)
                {
                    return D3DERR_INVALIDCALL;
                }
                // The length is in the stream: up to the end token, stepping over the
                // comment blocks, whose data may hold that word, at most 1 MiB.
                const words = [u32(shader >>> 0)];
                for (let at = (shader >>> 0) + 4; words.length < 262144; at += 4)
                {
                    const word = u32(at);
                    words.push(word);
                    if (word === 0x0000ffff)
                    {
                        break;
                    }
                    if ((word & 0xffff) === 0xfffe)
                    {
                        for (let n = word >>> 16 & 0x7fff; n > 0 && words.length < 262144; n--)
                        {
                            at += 4;
                            words.push(u32(at));
                        }
                    }
                }
                let listing;
                try
                {
                    listing = disassembleShader(Uint32Array.from(words), (comments >>> 0) === 0
                        ? undefined : { comments: latin1(cString(comments)) });
                }
                catch (e){
                    host.divergence?.('D3DXDisassembleShader', `refused: ${
                        /** @type {Error} */ (e).message}`);
                    return D3DERR_INVALIDCALL;
                }
                return giveBuffer(out, encode(listing));
            },
        },
    };
}
