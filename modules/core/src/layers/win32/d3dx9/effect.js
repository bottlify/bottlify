/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The effect framework of D3DX: ID3DXEffect, ID3DXEffectPool and
 * ID3DXEffectCompiler, and the functions that make them.
 *
 * An effect is read from HLSL source (`effect-model.js`): parameters, techniques,
 * passes, and the shaders the passes compile. Here it becomes the objects a
 * program holds. Parameters keep their values host-side, as the DWORDs D3DX keeps;
 * handles are blocks of guest memory holding the parameter's full name, so a
 * handle given back is found by its address and a name given instead finds the
 * same parameter -- D3DX takes either. A handle of one effect given to another
 * names the parameter of the first, as it does in D3DX, whose handles are pointers.
 *
 * Begin, BeginPass and CommitChanges put a pass on the program's device through
 * the device's own methods (or the program's state manager, when it set one): the
 * pass's states in the order written, each shader followed by its constants -- the
 * parameters of the same names, laid out by the shader's constant table -- and the
 * sampler states of the samplers it reads. CommitChanges sets again only what a
 * parameter written since has changed. Begin records what the technique sets in a
 * state block, unless told not to, and End puts it back.
 *
 * Parameters declared `shared` are shared by every effect made with the same pool:
 * the first effect to declare one gives it its value, and a write through any of
 * them is seen by all.
 *
 * What differs from D3DX, and is said where it happens:
 * - A compiled effect (fx_2_0 bytecode) is not read. The effect compiler's
 *   CompileEffect hands back this layer's own container -- the source, its macros
 *   and the files it included -- which D3DXCreateEffect takes back.
 * - The effect holds no reference on its device, on the textures set into its
 *   parameters or on the shaders and state blocks it made: a COM release from the
 *   last Release would be a call into the guest from inside one. GetDevice,
 *   GetTexture, GetValue of a texture and the shader getters do add the reference
 *   the caller releases.
 */

import { createComObject } from '../ole32/objects.js';
import { DEVICE, UNKNOWN_RELEASE, createDeviceCalls } from './device.js';
import { parseConstantTable, registerValues } from './constants.js';
import { compileShader } from './hlsl-compile.js';
import { PARAMETER, PC, PT, buildEffect, isSampler, isShader, isTexture } from './effect-model.js';

/** @typedef {import('./effect-model.js').EffectModel} EffectModel */
/** @typedef {import('./effect-model.js').ParamModel} ParamModel */
/** @typedef {import('./effect-model.js').StateModel} StateModel */
/** @typedef {import('./effect-model.js').PassModel} PassModel */
/** @typedef {import('./effect-model.js').TechniqueModel} TechniqueModel */
/** @typedef {import('./constants.js').Constant} Constant */
/** @typedef {import('../ole32/objects.js').ComMethod} ComMethod */

/** IID_ID3DXEffect: d3dx9_24 and _25, d3dx9_26, and every later version. */
export const IID_ID3DXEFFECT_25 = '{D165CCB1-62B0-4A33-B3FA-A92300305A11}';
export const IID_ID3DXEFFECT_26 = '{C7B17651-5420-490E-8A7F-923675A2D687}';
export const IID_ID3DXEFFECT = '{F6CEB4B3-4E4C-40DD-B883-8D8DE5EA0CD5}';
export const IID_ID3DXEFFECTPOOL = '{9537AB04-3250-412E-8213-FCD2F8677933}';
export const IID_ID3DXEFFECTCOMPILER = '{51B8A949-1A31-47E6-BEA0-4B30DB53F1E0}';

const D3D_OK = 0;
const S_FALSE = 1;
const E_FAIL = 0x80004005;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
const D3DERR_INVALIDCALL = 0x8876086c;

/** D3DXFX_* flags. */
export const FX = Object.freeze({ DONOTSAVESTATE: 1, DONOTSAVESHADERSTATE: 2,
    DONOTSAVESAMPLERSTATE: 4, NOT_CLONEABLE: 1 << 11, LARGEADDRESSAWARE: 1 << 17 });

/** The tag of a compiled effect, which this layer does not read. */
const FX_2_0 = 0xfeff0901;
/** The tag of this layer's own compiled effect: 'BTFX'. */
const CONTAINER = 0x58465442;

/** D3DVERTEXTEXTURESAMPLER0: a vertex shader's samplers are numbered from it. */
const VERTEX_SAMPLER_BASE = 257;

/** The creator D3DX names in an effect's description. */
const CREATOR = 'D3DX Effect Compiler';

/** IDirect3DDevice9's slots this file calls beyond `device.js`'s. */
const DEVICE_MORE = Object.freeze({
    SetMaterial: 49, SetLight: 51, LightEnable: 53, BeginStateBlock: 60, EndStateBlock: 61,
    SetNPatchMode: 79, CreateVertexShader: 91, SetVertexShaderConstantF: 94,
    SetVertexShaderConstantI: 96, SetVertexShaderConstantB: 98, CreatePixelShader: 106,
    SetPixelShaderConstantF: 109, SetPixelShaderConstantI: 111, SetPixelShaderConstantB: 113,
});

/** IDirect3DStateBlock9::Capture and Apply; IDirect3DBaseTexture9::GetLevelDesc. */
const STATEBLOCK = Object.freeze({ Capture: 4, Apply: 5 });
const TEXTURE_GETLEVELDESC = 17;

/**
 * Where each setter is, on the device and on ID3DXEffectStateManager (whose
 * methods follow IUnknown's in the order of the device's own).
 *
 * @type {Record<string, [number, number]>}
 */
const SETTERS = {
    SetTransform: [DEVICE.SetTransform, 3], SetMaterial: [DEVICE_MORE.SetMaterial, 4],
    SetLight: [DEVICE_MORE.SetLight, 5], LightEnable: [DEVICE_MORE.LightEnable, 6],
    SetRenderState: [DEVICE.SetRenderState, 7], SetTexture: [DEVICE.SetTexture, 8],
    SetTextureStageState: [DEVICE.SetTextureStageState, 9],
    SetSamplerState: [DEVICE.SetSamplerState, 10], SetNPatchMode: [DEVICE_MORE.SetNPatchMode, 11],
    SetFVF: [DEVICE.SetFVF, 12], SetVertexShader: [DEVICE.SetVertexShader, 13],
    SetVertexShaderConstantF: [DEVICE_MORE.SetVertexShaderConstantF, 14],
    SetVertexShaderConstantI: [DEVICE_MORE.SetVertexShaderConstantI, 15],
    SetVertexShaderConstantB: [DEVICE_MORE.SetVertexShaderConstantB, 16],
    SetPixelShader: [DEVICE.SetPixelShader, 17],
    SetPixelShaderConstantF: [DEVICE_MORE.SetPixelShaderConstantF, 18],
    SetPixelShaderConstantI: [DEVICE_MORE.SetPixelShaderConstantI, 19],
    SetPixelShaderConstantB: [DEVICE_MORE.SetPixelShaderConstantB, 20],
};

/** The constant setters, by register set (D3DXREGISTER_SET) and stage. */
const CONSTANT_SETTERS = [
    ['SetVertexShaderConstantB', 'SetPixelShaderConstantB'],
    ['SetVertexShaderConstantI', 'SetPixelShaderConstantI'],
    ['SetVertexShaderConstantF', 'SetPixelShaderConstantF'],
];

/**
 * The shader-constant states: the setter, and how many values a register takes.
 *
 * @type {Record<string, [string, number]>}
 */
const CONSTANT_STATES = {
    vsconstf: ['SetVertexShaderConstantF', 4], vsconsti: ['SetVertexShaderConstantI', 4],
    vsconstb: ['SetVertexShaderConstantB', 1], psconstf: ['SetPixelShaderConstantF', 4],
    psconsti: ['SetPixelShaderConstantI', 4], psconstb: ['SetPixelShaderConstantB', 1],
};

const D3DXERR_INVALIDDATA = 0x88760b59;

/** INT_FLOAT_MULTI: how D3DX packs a colour into an int and back. */
const COLOR_SCALE = 255;

/**
 * @typedef {Object} EffectHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {(steps: Steps) => any} [drive]
 *     Steps run by the bridge in the slice the call came in: what BeginPass and
 *     CommitChanges answer with, so a pass's states reach the program's state
 *     manager without a turn of the run loop for each.
 * @property {() => any} [currentThread]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 *     A file's bytes, for the FromFile functions; without it they are refused.
 * @property {(module: number, name: string | number, type: number) =>
 *     Promise<Uint8Array | null> | Uint8Array | null} [resource]
 *     A module's resource, for the FromResource functions; without it they are refused.
 * @property {(record: { api: string, profile: string, entry: string,
 *     defines: [string, string][], flags: number, source: string,
 *     included: Record<string, string>, messages: string, tokens: Uint32Array | null })
 *     => void} [shaderCompiled]
 */

/**
 * Steps of a host call that calls the guest: each guest call yielded, what it
 * returned handed back (EAX, signed), the answer returned.
 *
 * @typedef {Generator<{ entry: number, args: number[], thread?: any }, any, number>} Steps
 */

/**
 * What `functions.js` lends: the buffer, the program's include and macros as
 * D3DXCompileShader reads them, and the constant table it hands out.
 *
 * @typedef {Object} EffectHelpers
 * @property {(out: number, bytes: Uint8Array) => number} giveBuffer
 * @property {(include: number) => (name: string, system: boolean) => Promise<string | null>}
 *     includer
 * @property {(at: number) => [string, string][]} macrosAt
 * @property {(block: Uint8Array, version: number, out: number) => number} publishConstantTable
 */

/**
 * A store of parameter data: the DWORDs of one top-level parameter, and when they
 * were last written. A shared parameter's store is its pool's.
 *
 * @typedef {Object} Store
 * @property {DataView} view
 * @property {number} version
 * @property {Map<number, number>} strings   Heap copies of strings, by the offset that holds them.
 */

/**
 * @typedef {Object} Param
 * @property {ParamModel} model
 * @property {string | null} fullName   Null for an annotation of a technique or a pass.
 * @property {number} handle
 * @property {number} nameAt
 * @property {number} semanticAt
 * @property {Param[]} members
 * @property {Param[]} annotations
 * @property {Param | null} top   The top-level parameter it is part of; null for an annotation.
 * @property {Store} store
 * @property {number} offset   Where its data starts in the store.
 * @property {number} flags
 * @property {EffectState} effect
 * @property {Set<string>} [skip]
 */

/**
 * @typedef {Object} Shader
 * @property {number} pointer   The device's shader, or 0.
 * @property {boolean} pixel
 * @property {boolean} ok
 * @property {number} tokensAt   A copy of the bytecode, for GetPassDesc.
 * @property {{ constant: Constant, param: Param }[]} bindings
 */

/**
 * @typedef {Object} Pass
 * @property {PassModel} model
 * @property {number} handle
 * @property {number} nameAt
 * @property {Param[]} annotations
 * @property {number} applied   The version of the last time its states were set.
 */

/**
 * @typedef {Object} Technique
 * @property {TechniqueModel} model
 * @property {number} handle
 * @property {number} nameAt
 * @property {Param[]} annotations
 * @property {Pass[]} passes
 * @property {Map<number, number>} saved   State blocks by the Begin flags they keep.
 */

/**
 * @typedef {Object} EffectState
 * @property {'effect' | 'compiler'} kind
 * @property {EffectModel} model
 * @property {{ source: string, defines: [string, string][], files: any[], flags: number }} origin
 * @property {number} device
 * @property {any} pool   The pool's COM object, or null.
 * @property {number} poolPointer
 * @property {number} flags
 * @property {Param[]} params
 * @property {Map<string, Param>} byName   Every parameter by its full name.
 * @property {Technique[]} techniques
 * @property {Technique | null} current
 * @property {Shader[]} shaders
 * @property {Map<number, Shader>} shaderByPointer
 * @property {{ handle: number, nameAt: number, name: string }[]} functions
 * @property {boolean} started
 * @property {number} beginFlags
 * @property {Pass | null} active
 * @property {number} manager
 * @property {Uint8Array[]} lights
 * @property {number} lightsUpdated
 * @property {Uint8Array} material
 * @property {boolean} materialUpdated
 * @property {{ param: Param, bytes: Uint8Array }[] | null} recording
 * @property {Map<number, { param: Param, bytes: Uint8Array }[]>} blocks
 * @property {number[]} owned   Heap blocks that go with the effect.
 * @property {Set<string>} skip   Constants Ex was told not to set.
 * @property {number} version   Which ID3DXEffect layout it was handed out as.
 */

/**
 * @param {EffectHost} host
 * @param {EffectHelpers} helpers
 * @param {{ version?: number }} [options]   The d3dx9 version whose ID3DXEffect layout is
 *     handed out; the latest layout when absent.
 */
export function createEffects(host, helpers, options = {}){
    const version = options.version ?? 43;
    /** Every handle any effect of this process handed out, to what it names. @type {Map<number, any>} */
    const handles = new Map();
    /** The clock that dates parameter writes and pass applications. */
    let clock = 1;
    const { u32, putU32s, method, string } = createDeviceCalls(host);
    const heap = ()=>/** @type {NonNullable<EffectHost['heap']>} */ (host.heap);
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>putU32s(at, [value]);
    // One word seen both ways, so a conversion allocates nothing.
    const bitsWord = new Uint32Array(1);
    const floatWord = new Float32Array(bitsWord.buffer);
    /** @param {number} value */
    const asFloat = value=>{
        bitsWord[0] = value >>> 0;
        return floatWord[0];
    };
    /** @param {number} value */
    const floatBits = value=>{
        floatWord[0] = value;
        return bitsWord[0];
    };
    /** A NUL-ended string, at most 4 KB. @param {number} at */
    const cString = at=>string(at);
    /** @param {number} at */
    const wideString = at=>string(at, true, 512);
    /** Text as D3DX's strings are: a byte a character, then a NUL. @param {string} text */
    const encode = text=>Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0) & 0xff);
    /** @param {Uint8Array} bytes */
    const latin1 = bytes=>{
        let text = '';
        for (let at = 0; at < bytes.length; at += 8192)
        {
            text += String.fromCharCode(...bytes.subarray(at, at + 8192));
        }
        return text;
    };

    /** The creator's name, one copy for every effect. */
    let creatorAt = 0;

    /**
     * A block of the heap holding these strings one after another, each ended by
     * a NUL, owned by `owner`; the address of each.
     *
     * @param {number[]} owner @param {(string | null)[]} texts
     * @returns {number[]}  0 for a null string.
     */
    const strings = (owner, texts)=>{
        const parts = texts.map(s=>(s === null ? null : encode(s)));
        const size = parts.reduce((sum, p)=>sum + (p?.length ?? 0), 0);
        const base = heap().allocate(Math.max(size, 4));
        if (base === 0)
        {
            throw new RangeError('out of memory');
        }
        owner.push(base);
        let at = base;
        return parts.map(p=>{
            if (p === null)
            {
                return 0;
            }
            host.writeMemory(at, p);
            at += p.length;
            return at - p.length;
        });
    };

    // ---- parameters ------------------------------------------------------------------

    /**
     * The runtime of a parameter and everything under it, its handles in the heap.
     *
     * @param {EffectState} effect @param {ParamModel} model @param {string | null} fullName
     * @param {Param | null} top @param {Store} store @param {number} offset
     * @returns {Param}
     */
    const makeParam = (effect, model, fullName, top, store, offset)=>{
        const [handle, nameAt, semanticAt] = strings(effect.owned,
            [fullName ?? model.name, model.name, model.semantic]);
        /** @type {Param} */
        const param = { model, fullName, handle, nameAt, semanticAt, members: [], annotations: [],
            top, store, offset, flags: model.flags, effect };
        handles.set(handle, { kind: 'param', param });
        if (fullName !== null)
        {
            effect.byName.set(fullName, param);
        }
        let at = offset;
        param.members = model.members.map((member, i)=>{
            const name = fullName === null ? null : model.elements > 0 ? `${fullName}[${i}]`
                : `${fullName}.${member.name}`;
            const child = makeParam(effect, member, name, top ?? param, store, at);
            at += member.bytes;
            return child;
        });
        param.annotations = model.annotations.map(annotation=>annotationOf(effect, annotation,
            fullName === null ? null : `${fullName}@${annotation.name}`));
        return param;
    };

    /**
     * An annotation: a parameter of its own, with its own store, outside the tree
     * of a technique's or a pass's (whose annotations have no full name).
     *
     * @param {EffectState} effect @param {ParamModel} model @param {string | null} fullName
     */
    const annotationOf = (effect, model, fullName)=>{
        const store = newStore(model.bytes);
        const param = makeParam(effect, model, fullName, null, store, 0);
        param.top = null;
        fillDefaults(param);
        return param;
    };

    /** @param {number} bytes @returns {Store} */
    const newStore = bytes=>({ view: new DataView(new ArrayBuffer(Math.max(bytes, 4))),
        version: clock++, strings: new Map() });

    /**
     * A parameter's data set to its default: numbers as declared, strings copied
     * into the heap, shaders the effect made.
     *
     * @param {Param} param
     */
    const fillDefaults = param=>{
        param.model.init.forEach((slot, i)=>{
            const at = param.offset + i * 4;
            if ('word' in slot)
            {
                param.store.view.setUint32(at, slot.word >>> 0, true);
            }
            else if ('string' in slot)
            {
                writeString(param.store, at, slot.string);
            }
            else
            {
                const shader = slot.shader === null ? null : param.effect.shaders[slot.shader];
                param.store.view.setUint32(at, shader?.pointer ?? 0, true);
            }
        });
    };

    /** @param {Store} store @param {number} at @param {string} text */
    const writeString = (store, at, text)=>{
        const old = store.strings.get(at);
        const copy = heap().allocate(text.length + 1);
        if (copy !== 0)
        {
            host.writeMemory(copy, encode(text));
        }
        store.strings.set(at, copy);
        store.view.setUint32(at, copy, true);
        if (old)
        {
            heap().free(old);
        }
    };

    /** The words of a parameter's data. @param {Param} p */
    const wordsOf = p=>Array.from({ length: p.model.bytes >>> 2 }, (_, i)=>
        p.store.view.getUint32(p.offset + i * 4, true));

    /**
     * Writes words into a parameter's data from its start, dating the write and
     * recording it for a parameter block being recorded.
     *
     * @param {Param} p @param {number[]} words @param {number} [from]  The first word.
     */
    const writeWords = (p, words, from = 0)=>{
        words.forEach((word, i)=>{
            if ((from + i) * 4 < p.model.bytes)
            {
                p.store.view.setUint32(p.offset + (from + i) * 4, word >>> 0, true);
            }
        });
        touched(p);
    };

    /** @param {Param} p */
    const touched = p=>{
        p.store.version = clock++;
        const recording = p.effect.recording;
        if (recording)
        {
            recording.push({ param: p, bytes: new Uint8Array(p.store.view.buffer.slice(p.offset,
                p.offset + p.model.bytes)) });
        }
    };

    /**
     * A number held in a parameter's data, as another type reads it: D3DX's
     * conversions -- a float read as an int truncated, anything read as a BOOL
     * true when its DWORD is not zero.
     *
     * @param {number} word @param {number} from  D3DXPARAMETER_TYPE.
     * @param {number} to
     * @returns {number}  The word.
     */
    const convert = (word, from, to)=>{
        if (from === to)
        {
            return word >>> 0;
        }
        if (to === PT.BOOL)
        {
            return word !== 0 ? 1 : 0;
        }
        const value = from === PT.FLOAT ? asFloat(word) : from === PT.BOOL
            ? (word !== 0 ? 1 : 0) : word | 0;
        if (to === PT.FLOAT)
        {
            return floatBits(value);
        }
        return to === PT.INT ? Math.trunc(value) | 0 : 0;
    };

    /**
     * The parameter a handle names: one any effect handed out, or a name in this
     * effect's tree, unless the effect was made large-address-aware.
     *
     * @param {EffectState} effect @param {number} handle
     * @returns {Param | null}
     */
    const paramOf = (effect, handle)=>{
        if ((handle >>> 0) === 0)
        {
            return null;
        }
        const known = handles.get(handle >>> 0);
        if (known)
        {
            return known.kind === 'param' ? known.param : null;
        }
        if (effect.flags & FX.LARGEADDRESSAWARE)
        {
            return null;
        }
        return effect.byName.get(cString(handle)) ?? null;
    };

    /**
     * A name looked up under a parameter that has no full name -- an annotation of
     * a technique or a pass, or what is under one -- member by member, `.` and
     * `[n]` as D3DX reads them.
     *
     * @param {Param[]} list @param {string} name
     * @returns {Param | null}
     */
    const findIn = (list, name)=>{
        if (name === '')
        {
            return null;
        }
        const length = name.search(/[[.]/);
        for (const one of list)
        {
            if (one.model.name === name)
            {
                return one;
            }
            if (length > 0 && one.model.name === name.slice(0, length))
            {
                const rest = name.slice(length + 1);
                return name[length] === '.' ? findIn(one.members, rest) : elementBy(one, rest);
            }
        }
        return null;
    };

    /** `0]`, `0].x`: an element by the text after its `[`. @param {Param} p @param {string} text */
    const elementBy = (p, text)=>{
        const match = /^(\d+)\](.*)$/.exec(text);
        if (!match || Number(match[1]) >= p.model.elements)
        {
            return null;
        }
        const element = p.members[Number(match[1])];
        if (match[2] === '')
        {
            return element;
        }
        return match[2][0] === '.' ? findUnder(element, match[2].slice(1)) : null;
    };

    /**
     * A name under a parameter: its full name and the name, if it has one, else
     * its members searched.
     *
     * @param {Param} p @param {string} name
     */
    const findUnder = (p, name)=>{
        if (name === '')
        {
            return null;
        }
        if (p.fullName !== null)
        {
            return p.effect.byName.get(`${p.fullName}.${name}`) ?? null;
        }
        return findIn(p.members, name);
    };

    /** @param {EffectState} effect @param {number} handle @returns {Technique | null} */
    const techniqueOf = (effect, handle)=>{
        if ((handle >>> 0) === 0)
        {
            return null;
        }
        const own = effect.techniques.find(t=>t.handle === (handle >>> 0));
        if (own)
        {
            return own;
        }
        if (handles.has(handle >>> 0))
        {
            return null;
        }
        const name = cString(handle);
        return effect.techniques.find(t=>t.model.name === name) ?? null;
    };

    /** @param {EffectState} effect @param {number} handle @returns {Pass | null} */
    const passOf = (effect, handle)=>{
        for (const technique of effect.techniques)
        {
            const pass = technique.passes.find(p=>p.handle === (handle >>> 0));
            if (pass)
            {
                return pass;
            }
        }
        return null;
    };

    /**
     * The annotations of what a handle names: a pass, a technique, or a top-level
     * parameter (an element or a member has none).
     *
     * @param {EffectState} effect @param {number} handle
     * @returns {Param[]}
     */
    const annotationsOf = (effect, handle)=>{
        const pass = passOf(effect, handle);
        if (pass)
        {
            return pass.annotations;
        }
        const technique = techniqueOf(effect, handle);
        if (technique)
        {
            return technique.annotations;
        }
        const param = paramOf(effect, handle);
        return param && param.top === param ? param.annotations : [];
    };

    // ---- what a value set reads and a get writes --------------------------------------

    /** @param {number} at @param {number} count */
    const words = (at, count)=>{
        const bytes = host.readMemory(at >>> 0, count * 4);
        // One copy of the words in place of a call a word: every value an
        // effect is set comes through here, bone palettes of hundreds of words
        // among them, many times a frame. The guest's words are little-endian
        // as every host this runs on is; bytes not on a word boundary are
        // copied to one first.
        const aligned = (bytes.byteOffset & 3) === 0 ? bytes : bytes.slice();
        return Array.from(new Uint32Array(aligned.buffer, aligned.byteOffset, count));
    };

    /** @param {Param} p */
    const numeric = p=>p.model.cls === PC.SCALAR || p.model.cls === PC.VECTOR
        || p.model.cls === PC.MATRIX_ROWS || p.model.cls === PC.MATRIX_COLUMNS;

    /**
     * A D3DXMATRIX's floats as a matrix parameter of `p`'s shape holds them,
     * transposed if asked, each converted to its type.
     *
     * @param {Param} p @param {number} at @param {boolean} transpose
     */
    const matrixWords = (p, at, transpose)=>{
        const m = words(at, 16);
        /** @type {number[]} */
        const out = [];
        for (let r = 0; r < p.model.rows; r++)
        {
            for (let c = 0; c < p.model.columns; c++)
            {
                out.push(convert(transpose ? m[c * 4 + r] : m[r * 4 + c], PT.FLOAT, p.model.type));
            }
        }
        return out;
    };

    /**
     * A parameter's numbers as a D3DXMATRIX, zero outside its rows and columns.
     *
     * @param {Param} p @param {number} from  The word its matrix starts at.
     * @param {boolean} transpose
     */
    const matrixBytes = (p, from, transpose)=>{
        const out = new Uint32Array(16);
        const data = wordsOf(p);
        for (let r = 0; r < 4; r++)
        {
            for (let c = 0; c < 4; c++)
            {
                if (r < p.model.rows && c < p.model.columns)
                {
                    out[transpose ? c * 4 + r : r * 4 + c] = convert(
                        data[from + r * p.model.columns + c], p.model.type, PT.FLOAT);
                }
            }
        }
        return new Uint8Array(out.buffer);
    };

    /** A parameter's vector as a D3DXVECTOR4. @param {Param} p @param {number} from */
    const vectorBytes = (p, from)=>{
        const data = wordsOf(p);
        const out = new Uint32Array(4);
        for (let i = 0; i < 4; i++)
        {
            out[i] = i < p.model.columns ? convert(data[from + i], p.model.type, PT.FLOAT) : 0;
        }
        return new Uint8Array(out.buffer);
    };

    /**
     * An int as D3DX reads a colour: its bytes, ARGB, as floats in [0, 1].
     *
     * @param {number} n @returns {number[]}  r, g, b, a.
     */
    const unpackColor = n=>[(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, n >>> 24]
        .map(x=>Math.fround(x * Math.fround(1 / COLOR_SCALE)));
    /** @param {number} x */
    const colorByte = x=>Math.trunc(Math.min(Math.max(0, x), 1) * COLOR_SCALE);

    /** @param {Param} p */
    const isColorVector = p=>p.model.type === PT.FLOAT && !p.model.elements
        && ((p.model.cls === PC.VECTOR && p.model.columns !== 2)
        || (p.model.cls === PC.MATRIX_ROWS && p.model.rows !== 2 && p.model.columns === 1));

    /**
     * Gives back a reference on a COM object the caller now holds, once the
     * handler has returned.
     *
     * @param {any} thread @param {number} pointer
     */
    const addRefLater = (thread, pointer)=>Promise.resolve().then(()=>(pointer
        ? method(thread, pointer, 1, []) : 0)).then(()=>D3D_OK);

    /**
     * A texture parameter's words set. D3DX holds a reference on each texture it
     * is given (Wine's set_value); this layer does not.
     * ponytail: no reference is held -- an AddRef and a Release are a guest call
     * each, and a scene that sets a texture per draw parked its thread on every
     * one, the frame rate going to zero. Hold them once a reference can be taken
     * on the host.
     *
     * @param {Param} p @param {number[]} given
     */
    const setTextures = (p, given)=>{
        writeWords(p, given.map(word=>word >>> 0));
        return D3D_OK;
    };

    /**
     * The value setters and getters of ID3DXBaseEffect, in vtable order, for any
     * object whose state is an effect or a compiler.
     *
     * @returns {ComMethod[]}
     */
    const valueMethods = ()=>{
        /** @param {any} object */
        const of = object=>/** @type {EffectState} */ (object.state);
        return [
            /** HRESULT SetValue(D3DXHANDLE, LPCVOID pData, UINT Bytes) */
            { name: 'SetValue', argBytes: 16, invoke: (object, [h, data, bytes])=>{
                const p = paramOf(of(object), h);
                if (!p)
                {
                    return D3DERR_INVALIDCALL;
                }
                if (p.model.cls === PC.OBJECT && isSampler(p.model.type))
                {
                    return E_FAIL;
                }
                if ((data >>> 0) === 0 || p.model.bytes > (bytes >>> 0))
                {
                    return D3DERR_INVALIDCALL;
                }
                const given = words(data, p.model.bytes >>> 2);
                if (p.model.type === PT.STRING)
                {
                    given.forEach((at, i)=>writeString(p.store, p.offset + i * 4,
                        at ? cString(at) : ''));
                    touched(p);
                    return D3D_OK;
                }
                if (isTexture(p.model.type))
                {
                    return setTextures(p, given);
                }
                writeWords(p, given);
                return D3D_OK;
            } },
            /** HRESULT GetValue(D3DXHANDLE, LPVOID pData, UINT Bytes) */
            { name: 'GetValue', argBytes: 16, invoke: (object, [h, data, bytes])=>{
                const p = paramOf(of(object), h);
                if (!p)
                {
                    return D3DERR_INVALIDCALL;
                }
                if (p.model.cls === PC.OBJECT && isSampler(p.model.type))
                {
                    return E_FAIL;
                }
                if ((data >>> 0) === 0 || p.model.bytes > (bytes >>> 0))
                {
                    return D3DERR_INVALIDCALL;
                }
                const held = wordsOf(p).map(word=>(p.model.type === PT.BOOL
                    ? (word !== 0 ? 1 : 0) : word));
                putU32s(data, held);
                if (isTexture(p.model.type) || isShader(p.model.type))
                {
                    const thread = host.currentThread?.();
                    return held.reduce((chain, pointer)=>chain.then(()=>addRefLater(thread,
                        pointer)), Promise.resolve(D3D_OK));
                }
                return D3D_OK;
            } },
            /** HRESULT SetBool(D3DXHANDLE, BOOL) */
            { name: 'SetBool', argBytes: 12, invoke: (object, [h, b])=>{
                const p = paramOf(of(object), h);
                if (!p || p.model.elements || p.model.rows !== 1 || p.model.columns !== 1)
                {
                    return D3DERR_INVALIDCALL;
                }
                writeWords(p, [convert(b, PT.BOOL, p.model.type)]);
                return D3D_OK;
            } },
            /** HRESULT GetBool(D3DXHANDLE, BOOL *pb) */
            { name: 'GetBool', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p || p.model.elements || p.model.rows !== 1
                    || p.model.columns !== 1)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32(out, convert(wordsOf(p)[0], p.model.type, PT.BOOL));
                return D3D_OK;
            } },
            arraySetter('SetBoolArray', PT.INT),
            arrayGetter('GetBoolArray', PT.BOOL),
            /** HRESULT SetInt(D3DXHANDLE, INT) */
            { name: 'SetInt', argBytes: 12, invoke: (object, [h, n])=>{
                const p = paramOf(of(object), h);
                if (!p || p.model.elements)
                {
                    return D3DERR_INVALIDCALL;
                }
                if (p.model.rows === 1 && p.model.columns === 1)
                {
                    writeWords(p, [convert(n, PT.INT, p.model.type)]);
                    return D3D_OK;
                }
                if (isColorVector(p))
                {
                    // A colour given as an int: ARGB bytes to the vector's r, g, b, a.
                    const [r, g, b, a] = unpackColor(n);
                    const count = Math.min(4, p.model.rows * p.model.columns);
                    writeWords(p, [r, g, b, a].slice(0, count).map(floatBits));
                    return D3D_OK;
                }
                return D3DERR_INVALIDCALL;
            } },
            /** HRESULT GetInt(D3DXHANDLE, INT *pn) */
            { name: 'GetInt', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p || p.model.elements)
                {
                    return D3DERR_INVALIDCALL;
                }
                if (p.model.rows === 1 && p.model.columns === 1)
                {
                    putU32(out, convert(wordsOf(p)[0], p.model.type, PT.INT));
                    return D3D_OK;
                }
                if (isColorVector(p))
                {
                    const [r, g, b, a] = wordsOf(p).map(asFloat);
                    let n = colorByte(b) + (colorByte(g) << 8) + (colorByte(r) << 16);
                    if (p.model.rows * p.model.columns > 3)
                    {
                        n += colorByte(a) << 24;
                    }
                    putU32(out, n);
                    return D3D_OK;
                }
                return D3DERR_INVALIDCALL;
            } },
            arraySetter('SetIntArray', PT.INT),
            arrayGetter('GetIntArray', PT.INT),
            /** HRESULT SetFloat(D3DXHANDLE, FLOAT) */
            { name: 'SetFloat', argBytes: 12, invoke: (object, [h, f])=>{
                const p = paramOf(of(object), h);
                if (!p || p.model.elements || p.model.rows !== 1 || p.model.columns !== 1)
                {
                    return D3DERR_INVALIDCALL;
                }
                writeWords(p, [convert(f, PT.FLOAT, p.model.type)]);
                return D3D_OK;
            } },
            /** HRESULT GetFloat(D3DXHANDLE, FLOAT *pf) */
            { name: 'GetFloat', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p || p.model.elements || p.model.rows !== 1
                    || p.model.columns !== 1)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32(out, convert(wordsOf(p)[0], p.model.type, PT.FLOAT));
                return D3D_OK;
            } },
            arraySetter('SetFloatArray', PT.FLOAT),
            arrayGetter('GetFloatArray', PT.FLOAT),
            /** HRESULT SetVector(D3DXHANDLE, CONST D3DXVECTOR4 *) */
            { name: 'SetVector', argBytes: 12, invoke: (object, [h, at])=>{
                const p = paramOf(of(object), h);
                if (!p || p.model.elements || (p.model.cls !== PC.SCALAR
                    && p.model.cls !== PC.VECTOR) || (at >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const v = words(at, 4);
                if (p.model.type === PT.INT && p.model.bytes === 4)
                {
                    // A vector given to an int: a colour, packed ARGB.
                    const [r, g, b, a] = v.map(asFloat);
                    writeWords(p, [(colorByte(b) + (colorByte(g) << 8) + (colorByte(r) << 16)
                        + (colorByte(a) << 24)) >>> 0]);
                    return D3D_OK;
                }
                writeWords(p, v.slice(0, p.model.columns).map(word=>convert(word, PT.FLOAT,
                    p.model.type)));
                return D3D_OK;
            } },
            /** HRESULT GetVector(D3DXHANDLE, D3DXVECTOR4 *) */
            { name: 'GetVector', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p || p.model.elements || (p.model.cls !== PC.SCALAR
                    && p.model.cls !== PC.VECTOR))
                {
                    return D3DERR_INVALIDCALL;
                }
                if (p.model.type === PT.INT && p.model.bytes === 4)
                {
                    putU32s(out, unpackColor(wordsOf(p)[0]).map(floatBits));
                    return D3D_OK;
                }
                host.writeMemory(out >>> 0, vectorBytes(p, 0));
                return D3D_OK;
            } },
            /** HRESULT SetVectorArray(D3DXHANDLE, CONST D3DXVECTOR4 *, UINT Count) */
            { name: 'SetVectorArray', argBytes: 16, invoke: (object, [h, at, count])=>{
                const p = paramOf(of(object), h);
                if (!p || !p.model.elements || p.model.elements < (count >>> 0)
                    || p.model.cls !== PC.VECTOR)
                {
                    return D3DERR_INVALIDCALL;
                }
                /** @type {number[]} */
                const out = [];
                for (let i = 0; i < (count >>> 0); i++)
                {
                    out.push(...words(at + i * 16, p.model.columns).map(word=>convert(word,
                        PT.FLOAT, p.model.type)));
                }
                writeWords(p, out);
                return D3D_OK;
            } },
            /** HRESULT GetVectorArray(D3DXHANDLE, D3DXVECTOR4 *, UINT Count) */
            { name: 'GetVectorArray', argBytes: 16, invoke: (object, [h, out, count])=>{
                if ((count >>> 0) === 0)
                {
                    return D3D_OK;
                }
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p || (count >>> 0) > p.model.elements
                    || p.model.cls !== PC.VECTOR)
                {
                    return D3DERR_INVALIDCALL;
                }
                for (let i = 0; i < (count >>> 0); i++)
                {
                    host.writeMemory(out + i * 16, vectorBytes(p, i * p.model.columns));
                }
                return D3D_OK;
            } },
            ...matrixMethods(''),
            ...matrixMethods('Transpose'),
            /** HRESULT SetString(D3DXHANDLE, LPCSTR) */
            { name: 'SetString', argBytes: 12, invoke: (object, [h, at])=>{
                const p = paramOf(of(object), h);
                if (!p || p.model.type !== PT.STRING || (at >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                writeString(p.store, p.offset, cString(at));
                touched(p);
                return D3D_OK;
            } },
            /** HRESULT GetString(D3DXHANDLE, LPCSTR *) */
            { name: 'GetString', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p || p.model.elements || p.model.type !== PT.STRING)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32(out, wordsOf(p)[0]);
                return D3D_OK;
            } },
            /** HRESULT SetTexture(D3DXHANDLE, LPDIRECT3DBASETEXTURE9) */
            { name: 'SetTexture', argBytes: 12, invoke: (object, [h, texture])=>{
                const p = paramOf(of(object), h);
                if (!p || p.model.elements || !isTexture(p.model.type))
                {
                    return D3DERR_INVALIDCALL;
                }
                return setTextures(p, [texture >>> 0]);
            } },
            /** HRESULT GetTexture(D3DXHANDLE, LPDIRECT3DBASETEXTURE9 *) */
            objectGetter('GetTexture', isTexture),
            /** HRESULT GetPixelShader(D3DXHANDLE, LPDIRECT3DPIXELSHADER9 *) */
            objectGetter('GetPixelShader', type=>type === PT.PIXELSHADER),
            /** HRESULT GetVertexShader(D3DXHANDLE, LPDIRECT3DVERTEXSHADER9 *) */
            objectGetter('GetVertexShader', type=>type === PT.VERTEXSHADER),
            /**
             * HRESULT SetArrayRange(D3DXHANDLE, UINT uStart, UINT uEnd)
             *
             * A hint for the range of an array a shader reads, which this layer sets whole
             * anyway.
             */
            { name: 'SetArrayRange', argBytes: 16, invoke: ()=>D3D_OK },
        ];
    };

    /**
     * SetBoolArray, SetIntArray, SetFloatArray: as many numbers as the parameter
     * holds, from its start, each converted to its type.
     *
     * @param {string} name @param {number} from  The type the numbers are given in.
     * @returns {ComMethod}
     */
    const arraySetter = (name, from)=>({ name, argBytes: 16, invoke: (object, [h, at, count])=>{
        const p = paramOf(object.state, h);
        if (!p || !numeric(p) || p.model.cls === PC.MATRIX_COLUMNS)
        {
            return D3DERR_INVALIDCALL;
        }
        const size = Math.min(count >>> 0, p.model.bytes >>> 2);
        writeWords(p, words(at, size).map(word=>convert(word, from, p.model.type)));
        return D3D_OK;
    } });

    /**
     * GetBoolArray, GetIntArray, GetFloatArray.
     *
     * @param {string} name @param {number} to
     * @returns {ComMethod}
     */
    const arrayGetter = (name, to)=>({ name, argBytes: 16, invoke: (object, [h, out, count])=>{
        const p = paramOf(object.state, h);
        if ((out >>> 0) === 0 || !p || !numeric(p))
        {
            return D3DERR_INVALIDCALL;
        }
        const size = Math.min(count >>> 0, p.model.bytes >>> 2);
        putU32s(out, wordsOf(p).slice(0, size).map(word=>convert(word, p.model.type, to)));
        return D3D_OK;
    } });

    /**
     * GetTexture and the shader getters: the pointer, with a reference added.
     *
     * @param {string} name @param {(type: number) => boolean} accepts
     * @returns {ComMethod}
     */
    const objectGetter = (name, accepts)=>({ name, argBytes: 12, invoke: (object, [h, out])=>{
        const p = paramOf(object.state, h);
        if ((out >>> 0) === 0 || !p || p.model.elements || !accepts(p.model.type))
        {
            return D3DERR_INVALIDCALL;
        }
        const pointer = wordsOf(p)[0];
        putU32(out, pointer);
        return addRefLater(host.currentThread?.(), pointer);
    } });

    /**
     * The matrix setters and getters, plain or transposed, in their vtable order.
     *
     * @param {'' | 'Transpose'} kind
     * @returns {ComMethod[]}
     */
    const matrixMethods = kind=>{
        const transpose = kind === 'Transpose';
        /** @param {Param | null} p */
        const isMatrix = p=>p?.model.cls === PC.MATRIX_ROWS;
        /** @param {Param} p */
        const size = p=>p.model.rows * p.model.columns;
        /**
         * @param {Param} p @param {number} count @param {(i: number) => number} matrixAt
         */
        const setMany = (p, count, matrixAt)=>{
            writeWords(p, Array.from({ length: count }, (_, i)=>matrixWords(p, matrixAt(i),
                transpose)).flat());
            return D3D_OK;
        };
        /**
         * @param {Param} p @param {number} count @param {(i: number) => number} matrixAt
         */
        const getMany = (p, count, matrixAt)=>{
            for (let i = 0; i < count; i++)
            {
                host.writeMemory(matrixAt(i) >>> 0, matrixBytes(p, i * size(p), transpose));
            }
            return D3D_OK;
        };
        return [
            { name: `SetMatrix${kind}`, argBytes: 12, invoke: (object, [h, at])=>{
                const p = paramOf(object.state, h);
                return p && !p.model.elements && isMatrix(p) && (at >>> 0) !== 0
                    ? setMany(p, 1, ()=>at) : D3DERR_INVALIDCALL;
            } },
            { name: `GetMatrix${kind}`, argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(object.state, h);
                // A vector or a scalar read through the transposed getter is read
                // as a matrix of one row, untransposed.
                if (p && (out >>> 0) !== 0 && !p.model.elements && transpose
                    && (p.model.cls === PC.SCALAR || p.model.cls === PC.VECTOR))
                {
                    host.writeMemory(out >>> 0, matrixBytes(p, 0, false));
                    return D3D_OK;
                }
                return p && (out >>> 0) !== 0 && !p.model.elements && isMatrix(p)
                    ? getMany(p, 1, ()=>out) : D3DERR_INVALIDCALL;
            } },
            { name: `SetMatrix${kind}Array`, argBytes: 16, invoke: (object, [h, at, count])=>{
                const p = paramOf(object.state, h);
                return p && p.model.elements >= (count >>> 0) && isMatrix(p)
                    ? setMany(p, count >>> 0, i=>at + i * 64) : D3DERR_INVALIDCALL;
            } },
            { name: `GetMatrix${kind}Array`, argBytes: 16, invoke: (object, [h, out, count])=>{
                if ((count >>> 0) === 0)
                {
                    return D3D_OK;
                }
                const p = paramOf(object.state, h);
                return p && (out >>> 0) !== 0 && (count >>> 0) <= p.model.elements && isMatrix(p)
                    ? getMany(p, count >>> 0, i=>out + i * 64) : D3DERR_INVALIDCALL;
            } },
            { name: `SetMatrix${kind}PointerArray`, argBytes: 16,
                invoke: (object, [h, at, count])=>{
                    const p = paramOf(object.state, h);
                    return p && (count >>> 0) <= p.model.elements && isMatrix(p)
                        ? setMany(p, count >>> 0, i=>u32(at + i * 4)) : D3DERR_INVALIDCALL;
                } },
            { name: `GetMatrix${kind}PointerArray`, argBytes: 16,
                invoke: (object, [h, out, count])=>{
                    if ((count >>> 0) === 0)
                    {
                        return D3D_OK;
                    }
                    const p = paramOf(object.state, h);
                    return p && (out >>> 0) !== 0 && (count >>> 0) <= p.model.elements
                        && isMatrix(p) ? getMany(p, count >>> 0, i=>u32(out + i * 4))
                        : D3DERR_INVALIDCALL;
                } },
        ];
    };

    /**
     * ID3DXBaseEffect's methods, in vtable order.
     *
     * @returns {ComMethod[]}
     */
    const baseMethods = ()=>{
        /** @param {any} object @returns {EffectState} */
        const of = object=>object.state;
        /** @param {number} out @param {Param} p */
        const describe = (out, p)=>putU32s(out, [p.nameAt, p.semanticAt, p.model.cls,
            p.model.type, p.model.rows, p.model.columns, p.model.elements,
            p.top === p ? p.annotations.length : 0, p.model.elements
                ? p.model.members[0]?.members.length ?? 0 : p.model.members.length,
            p.flags, p.model.bytes]);
        return [
            /** HRESULT GetDesc(D3DXEFFECT_DESC *) */
            { name: 'GetDesc', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const effect = of(object);
                const compiler = effect.kind === 'compiler';
                putU32s(out, [compiler ? 0 : creatorAt, effect.params.length,
                    effect.techniques.length, compiler ? effect.functions.length : 0]);
                return D3D_OK;
            } },
            /** HRESULT GetParameterDesc(D3DXHANDLE, D3DXPARAMETER_DESC *) */
            { name: 'GetParameterDesc', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(of(object), h);
                if ((out >>> 0) === 0 || !p)
                {
                    return D3DERR_INVALIDCALL;
                }
                describe(out, p);
                return D3D_OK;
            } },
            /** HRESULT GetTechniqueDesc(D3DXHANDLE, D3DXTECHNIQUE_DESC *) */
            { name: 'GetTechniqueDesc', argBytes: 12, invoke: (object, [h, out])=>{
                const effect = of(object);
                const t = (h >>> 0) === 0 ? effect.techniques[0] ?? null : techniqueOf(effect, h);
                if ((out >>> 0) === 0 || !t)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32s(out, [t.nameAt, t.passes.length, t.annotations.length]);
                return D3D_OK;
            } },
            /** HRESULT GetPassDesc(D3DXHANDLE, D3DXPASS_DESC *) */
            { name: 'GetPassDesc', argBytes: 12, invoke: (object, [h, out])=>{
                const effect = of(object);
                const pass = passOf(effect, h);
                if ((out >>> 0) === 0 || !pass)
                {
                    return D3DERR_INVALIDCALL;
                }
                const shaders = [0, 0];
                if (!(effect.flags & FX.NOT_CLONEABLE))
                {
                    for (const state of pass.model.states)
                    {
                        if (state.kind === 'vs' || state.kind === 'ps')
                        {
                            shaders[state.kind === 'vs' ? 0 : 1] = shaderFor(effect, state)
                                ?.tokensAt ?? 0;
                        }
                    }
                }
                putU32s(out, [pass.nameAt, pass.annotations.length, ...shaders]);
                return D3D_OK;
            } },
            /** HRESULT GetFunctionDesc(D3DXHANDLE, D3DXFUNCTION_DESC *) */
            { name: 'GetFunctionDesc', argBytes: 12, invoke: (object, [h, out])=>{
                const fn = functionOf(of(object), h);
                if ((out >>> 0) === 0 || !fn)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32s(out, [fn.nameAt, 0]);
                return D3D_OK;
            } },
            /** D3DXHANDLE GetParameter(D3DXHANDLE hParent, UINT Index) */
            { name: 'GetParameter', argBytes: 12, invoke: (object, [h, index])=>{
                const effect = of(object);
                if ((h >>> 0) === 0)
                {
                    return effect.params[index >>> 0]?.handle ?? 0;
                }
                const p = paramOf(effect, h);
                return p && !p.model.elements ? p.members[index >>> 0]?.handle ?? 0 : 0;
            } },
            /** D3DXHANDLE GetParameterByName(D3DXHANDLE hParent, LPCSTR pName) */
            { name: 'GetParameterByName', argBytes: 12, invoke: (object, [h, name])=>{
                const effect = of(object);
                const parent = paramOf(effect, h);
                if ((name >>> 0) === 0)
                {
                    return parent?.handle ?? 0;
                }
                const text = cString(name);
                if (!parent)
                {
                    return effect.byName.get(text)?.handle ?? 0;
                }
                return findUnder(parent, text)?.handle ?? 0;
            } },
            /** D3DXHANDLE GetParameterBySemantic(D3DXHANDLE hParent, LPCSTR pSemantic) */
            { name: 'GetParameterBySemantic', argBytes: 12, invoke: (object, [h, semantic])=>{
                const effect = of(object);
                const parent = (h >>> 0) === 0 ? null : paramOf(effect, h);
                if ((h >>> 0) !== 0 && !parent)
                {
                    return 0;
                }
                const wanted = (semantic >>> 0) === 0 ? null : cString(semantic).toLowerCase();
                const list = parent ? parent.members : effect.params;
                const found = list.find(p=>(p.model.semantic === null ? wanted === null
                    : wanted !== null && p.model.semantic.toLowerCase() === wanted));
                return found?.handle ?? 0;
            } },
            /** D3DXHANDLE GetParameterElement(D3DXHANDLE hParent, UINT ElementIndex) */
            { name: 'GetParameterElement', argBytes: 12, invoke: (object, [h, index])=>{
                const effect = of(object);
                const p = paramOf(effect, h);
                if (!p)
                {
                    return effect.params[index >>> 0]?.handle ?? 0;
                }
                return (index >>> 0) < p.model.elements ? p.members[index >>> 0].handle : 0;
            } },
            /** D3DXHANDLE GetTechnique(UINT Index) */
            { name: 'GetTechnique', argBytes: 8, invoke: (object, [index])=>
                of(object).techniques[index >>> 0]?.handle ?? 0 },
            /** D3DXHANDLE GetTechniqueByName(LPCSTR pName) */
            { name: 'GetTechniqueByName', argBytes: 8, invoke: (object, [name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                const text = cString(name);
                return of(object).techniques.find(t=>t.model.name === text)?.handle ?? 0;
            } },
            /** D3DXHANDLE GetPass(D3DXHANDLE hTechnique, UINT Index) */
            { name: 'GetPass', argBytes: 12, invoke: (object, [h, index])=>
                techniqueOf(of(object), h)?.passes[index >>> 0]?.handle ?? 0 },
            /** D3DXHANDLE GetPassByName(D3DXHANDLE hTechnique, LPCSTR pName) */
            { name: 'GetPassByName', argBytes: 12, invoke: (object, [h, name])=>{
                const t = techniqueOf(of(object), h);
                if (!t || (name >>> 0) === 0)
                {
                    return 0;
                }
                const text = cString(name);
                return t.passes.find(p=>p.model.name === text)?.handle ?? 0;
            } },
            /** D3DXHANDLE GetFunction(UINT Index) */
            { name: 'GetFunction', argBytes: 8, invoke: (object, [index])=>
                of(object).functions[index >>> 0]?.handle ?? 0 },
            /** D3DXHANDLE GetFunctionByName(LPCSTR pName) */
            { name: 'GetFunctionByName', argBytes: 8, invoke: (object, [name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                const text = cString(name);
                return of(object).functions.find(f=>f.name === text)?.handle ?? 0;
            } },
            /** D3DXHANDLE GetAnnotation(D3DXHANDLE hObject, UINT Index) */
            { name: 'GetAnnotation', argBytes: 12, invoke: (object, [h, index])=>
                annotationsOf(of(object), h)[index >>> 0]?.handle ?? 0 },
            /** D3DXHANDLE GetAnnotationByName(D3DXHANDLE hObject, LPCSTR pName) */
            { name: 'GetAnnotationByName', argBytes: 12, invoke: (object, [h, name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                return findIn(annotationsOf(of(object), h), cString(name))?.handle ?? 0;
            } },
            ...valueMethods(),
        ];
    };

    /** @param {EffectState} effect @param {number} h */
    const functionOf = (effect, h)=>{
        if ((h >>> 0) === 0)
        {
            return null;
        }
        const own = effect.functions.find(f=>f.handle === (h >>> 0));
        if (own || handles.has(h >>> 0))
        {
            return own ?? null;
        }
        const name = cString(h);
        return effect.functions.find(f=>f.name === name) ?? null;
    };

    // ---- applying a pass ---------------------------------------------------------------

    /**
     * Sets one thing on the device, or on the program's state manager when it set
     * one: the setter by its device name, its arguments after `this`.
     *
     * @param {EffectState} effect @param {any} thread @param {string} name
     * @param {number[]} args @param {boolean} [direct]  Past the state manager.
     */
    const set = function*(effect, thread, name, args, direct = false){
        const [deviceSlot, managerSlot] = SETTERS[name];
        return yield* methodStep(thread, effect.manager && !direct ? effect.manager
            : effect.device, effect.manager && !direct ? managerSlot : deviceSlot, args);
    };

    /**
     * A method of a COM object in guest memory as a step: its answer as an
     * unsigned HRESULT.
     *
     * @param {any} thread @param {number} object @param {number} slot @param {number[]} rest
     * @returns {Steps}
     */
    const methodStep = function*(thread, object, slot, rest){
        const answer = yield { entry: u32(u32(object) + slot * 4), args: [object >>> 0, ...rest],
            ...(thread === undefined ? {} : { thread }) };
        return answer >>> 0;
    };

    /**
     * Steps run through promises, each guest call through `callGuest`: for a
     * host that cannot drive them, and for an async caller of its own.
     *
     * @param {Steps} steps
     * @returns {Promise<any>}
     */
    const stepsThroughPromises = async steps=>{
        // Begun once the handler has returned and its caller is parked, as these
        // calls always were on this path: nothing of the guest runs inside it.
        await null;
        /** @type {number | undefined} */
        let returned;
        for (;;)
        {
            const next = steps.next(/** @type {number} */ (returned));
            if (next.done)
            {
                return next.value;
            }
            returned = await /** @type {NonNullable<EffectHost['callGuest']>} */ (
                host.callGuest)(next.value);
        }
    };

    /**
     * What a handler answers with for steps: the bridge's to run in the slice,
     * or a promise where the host has no bridge to.
     *
     * @param {Steps} steps
     */
    const answerWith = steps=>(host.drive ? host.drive(steps) : stepsThroughPromises(steps));

    /**
     * Bytes in the heap for the length of the steps given them, freed after.
     *
     * @param {Uint8Array} bytes @param {(at: number) => Steps} use
     * @returns {Steps}
     */
    const withBytesStep = function*(bytes, use){
        const at = heap().allocate(Math.max(bytes.length, 4));
        if (at === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            host.writeMemory(at, bytes);
            return yield* use(at);
        }
        finally
        {
            heap().free(at);
        }
    };

    /**
     * Bytes in the heap for the length of one call, freed after it.
     *
     * @template T
     * @param {Uint8Array} bytes @param {(at: number) => Promise<T>} use
     * @returns {Promise<T | number>}
     */
    const withBytes = async(bytes, use)=>{
        const at = heap().allocate(Math.max(bytes.length, 4));
        if (at === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            host.writeMemory(at, bytes);
            return await use(at);
        }
        finally
        {
            heap().free(at);
        }
    };

    /** @param {number[]} values */
    const u32Bytes = values=>new Uint8Array(Uint32Array.from(values, v=>v >>> 0).buffer);

    /**
     * The shader a VertexShader or PixelShader state sets: one the pass compiled,
     * or the one a shader parameter holds.
     *
     * @param {EffectState} effect @param {StateModel} state
     * @returns {Shader | null}
     */
    const shaderFor = (effect, state)=>{
        const source = state.source;
        if (source.kind === 'shader')
        {
            return source.shader === null ? null : effect.shaders[source.shader];
        }
        if (source.kind === 'param')
        {
            const p = effect.byName.get(source.path);
            return p ? effect.shaderByPointer.get(wordsOf(p)[0]) ?? null : null;
        }
        return null;
    };

    /**
     * A state's value now, and whether it changed since the pass was last applied.
     *
     * @param {EffectState} effect @param {Pass | null} pass @param {StateModel} state
     * @returns {{ words: number[], param: Param | null, dirty: boolean } | null}
     */
    const valueOf = (effect, pass, state)=>{
        const source = state.source;
        if (source.kind === 'const')
        {
            return { words: source.words, param: null, dirty: false };
        }
        if (source.kind === 'shader')
        {
            const shader = source.shader === null ? null : effect.shaders[source.shader];
            return { words: [shader?.pointer ?? 0], param: null, dirty: false };
        }
        const p = effect.byName.get(source.path);
        if (!p)
        {
            return null;
        }
        const dirty = pass ? p.store.version > pass.applied : true;
        const held = wordsOf(p);
        if (p.model.cls === PC.OBJECT)
        {
            return { words: held, param: p, dirty };
        }
        const numbers = held.map(word=>(p.model.type === PT.FLOAT ? asFloat(word)
            : p.model.type === PT.BOOL ? (word !== 0 ? 1 : 0) : word | 0));
        switch (state.value)
        {
            case 'float':
                return { words: [floatBits(numbers[0] ?? 0)], param: p, dirty };
            case 'vector':
            case 'matrix':
                return { words: numbers.map(floatBits), param: p, dirty };
            case 'ints':
                return { words: numbers.map(x=>Math.trunc(x) >>> 0), param: p, dirty };
            case 'color':
                if (p.model.type === PT.FLOAT && numbers.length >= 3)
                {
                    const [r, g, b, a = 1] = numbers;
                    const byte = (/** @type {number} */ x)=>Math.max(0, Math.min(255,
                        Math.round(x * 255)));
                    return { words: [((byte(a) << 24) | (byte(r) << 16) | (byte(g) << 8)
                        | byte(b)) >>> 0], param: p, dirty };
                }
                return { words: [held[0] ?? 0], param: p, dirty };
            default:
                return { words: [p.model.type === PT.FLOAT ? Math.trunc(numbers[0] ?? 0) >>> 0
                    : (held[0] ?? 0) >>> 0], param: p, dirty };
        }
    };

    /**
     * Sets one state of a pass.
     *
     * @param {EffectState} effect @param {Pass | null} pass @param {StateModel} state
     * @param {number} unit   The sampler a sampler's states go to, or -1 for the state's own.
     * @param {boolean} all   Whether to set what has not changed too.
     * @param {any} thread
     * @param {number} keep   What a recording leaves out: D3DXFX_DONOTSAVE* flags.
     * @returns {Steps}
     */
    const applyState = function*(effect, pass, state, unit, all, thread, keep){
        const value = valueOf(effect, pass, state);
        if (!value)
        {
            return D3D_OK;
        }
        const kind = state.kind;
        if (!(all || value.dirty || kind === 'vs' || kind === 'ps' || kind === 'setsampler'))
        {
            return D3D_OK;
        }
        const index = state.index < 0 ? 0 : state.index;
        const first = value.words[0] ?? 0;
        switch (kind)
        {
            case 'render':
                return yield* set(effect, thread, 'SetRenderState', [state.op, first]);
            case 'stage':
                return yield* set(effect, thread, 'SetTextureStageState', [index, state.op, first]);
            case 'sampler':
                if (keep & FX.DONOTSAVESAMPLERSTATE)
                {
                    return D3D_OK;
                }
                return yield* set(effect, thread, 'SetSamplerState', [unit < 0 ? index : unit,
                    state.op, first]);
            case 'texture':
                return yield* set(effect, thread, 'SetTexture', [unit < 0 ? index : unit, first]);
            case 'setsampler': {
                const p = value.param;
                if (!p || !isSampler(p.model.type) || (keep & FX.DONOTSAVESAMPLERSTATE))
                {
                    return D3D_OK;
                }
                return yield* applySampler(effect, pass, p, index, all, thread, keep);
            }
            case 'vs':
            case 'ps': {
                if (keep & FX.DONOTSAVESHADERSTATE)
                {
                    return D3D_OK;
                }
                const shader = shaderFor(effect, state);
                const changed = all || value.dirty;
                if (changed)
                {
                    const answer = yield* set(effect, thread, kind === 'vs' ? 'SetVertexShader'
                        : 'SetPixelShader', [shader?.pointer ?? 0]);
                    if (answer !== D3D_OK)
                    {
                        return answer;
                    }
                }
                return shader?.pointer
                    ? yield* applyConstants(effect, pass, shader, changed, thread, keep) : D3D_OK;
            }
            case 'transform':
                return yield* withBytesStep(u32Bytes(padded(value.words, 16)), at=>set(effect,
                    thread, 'SetTransform', [state.op + (state.index < 0 ? 0 : state.index), at]));
            case 'lightenable':
                return yield* set(effect, thread, 'LightEnable', [index, first ? 1 : 0]);
            case 'light': {
                const light = effect.lights[index] ?? (effect.lights[index] = new Uint8Array(104));
                // Position and direction are three floats; the colours four.
                const count = state.value !== 'vector' ? 1
                    : state.op === 52 || state.op === 64 ? 3 : 4;
                light.set(u32Bytes(padded(value.words, count)), state.op);
                effect.lightsUpdated |= 1 << index;
                return D3D_OK;
            }
            case 'material':
                effect.material.set(u32Bytes(padded(value.words, state.value === 'vector' ? 4 : 1)),
                    state.op);
                effect.materialUpdated = true;
                return D3D_OK;
            case 'fvf':
                return yield* set(effect, thread, 'SetFVF', [first]);
            case 'npatch':
                return yield* set(effect, thread, 'SetNPatchMode', [first]);
            default: {
                const target = CONSTANT_STATES[kind];
                if (!target)
                {
                    return D3D_OK;
                }
                const [setter, perRegister] = target;
                const count = Math.max(1, Math.ceil(value.words.length / perRegister));
                return yield* withBytesStep(u32Bytes(padded(value.words, count * perRegister)),
                    at=>set(effect, thread, setter, [index, at, count]));
            }
        }
    };

    /** @param {number[]} values @param {number} length */
    const padded = (values, length)=>Array.from({ length }, (_, i)=>values[i] ?? 0);

    /**
     * The states of a sampler parameter, set on a sampler: its texture and its
     * sampler states.
     *
     * @param {EffectState} effect @param {Pass | null} pass @param {Param} p
     * @param {number} unit @param {boolean} all @param {any} thread @param {number} keep
     */
    const applySampler = function*(effect, pass, p, unit, all, thread, keep){
        let answer = D3D_OK;
        for (const state of p.model.samplers[0] ?? [])
        {
            const result = yield* applyState(effect, pass, state, unit, all, thread, keep);
            answer = result !== D3D_OK ? result : answer;
        }
        return answer;
    };

    /**
     * A shader's constants from the parameters of the same names, through the
     * constant setters, and the states of the samplers it reads.
     *
     * @param {EffectState} effect @param {Pass | null} pass @param {Shader} shader
     * @param {boolean} all @param {any} thread @param {number} keep
     */
    const applyConstants = function*(effect, pass, shader, all, thread, keep){
        let answer = D3D_OK;
        for (const { constant, param } of shader.bindings)
        {
            if (effect.skip.has(param.model.name))
            {
                continue;
            }
            const dirty = !pass || param.store.version > pass.applied;
            if (constant.set === 3)
            {
                if (keep & FX.DONOTSAVESAMPLERSTATE)
                {
                    continue;
                }
                for (let k = 0; k < Math.max(1, constant.count); k++)
                {
                    const element = param.model.elements ? param.members[k] : param;
                    if (!element)
                    {
                        continue;
                    }
                    const unit = constant.index + k + (shader.pixel ? 0 : VERTEX_SAMPLER_BASE);
                    const result = yield* applySampler(effect, pass, element, unit, all || dirty,
                        thread, keep);
                    answer = result !== D3D_OK ? result : answer;
                }
                continue;
            }
            if (!all && !dirty)
            {
                continue;
            }
            const result = yield* storeConstant(effect, shader, constant, param, thread);
            answer = result !== D3D_OK ? result : answer;
        }
        return answer;
    };

    /**
     * One constant's registers from its parameter's values.
     *
     * @param {EffectState} effect @param {Shader} shader @param {Constant} constant
     * @param {Param} param @param {any} thread
     * @returns {Steps}
     */
    const storeConstant = function*(effect, shader, constant, param, thread){
        if (constant.cls === PC.STRUCT || constant.members.length > 0)
        {
            let answer = D3D_OK;
            const elements = Math.max(1, constant.elements);
            const span = constant.members.reduce((sum, m)=>sum + m.count, 0);
            for (let e = 0; e < elements; e++)
            {
                const holder = param.model.elements ? param.members[e] : param;
                if (!holder)
                {
                    break;
                }
                for (const member of constant.members)
                {
                    const p = holder.members.find(m=>m.model.name === member.name);
                    if (p)
                    {
                        const result = yield* storeConstant(effect, shader, { ...member,
                            index: member.index + e * span }, p, thread);
                        answer = result !== D3D_OK ? result : answer;
                    }
                }
            }
            return answer;
        }
        if (!numeric(param))
        {
            return D3D_OK;
        }
        const values = wordsOf(param).map(word=>(param.model.type === PT.FLOAT ? asFloat(word)
            : param.model.type === PT.BOOL ? (word !== 0 ? 1 : 0) : word | 0));
        const { registers, count } = registerValues(constant, values);
        if (count === 0)
        {
            return D3D_OK;
        }
        const bytes = new DataView(new ArrayBuffer(count * 16));
        const units = constant.set === 0 ? count : count * 4;
        for (let i = 0; i < units; i++)
        {
            const value = registers[constant.set === 0 ? i * 4 : i];
            if (constant.set === 2)
            {
                bytes.setFloat32(i * 4, value, true);
            }
            else
            {
                bytes.setInt32(i * 4, constant.set === 0 ? (value !== 0 ? 1 : 0)
                    : Math.trunc(value), true);
            }
        }
        const setter = CONSTANT_SETTERS[constant.set][shader.pixel ? 1 : 0];
        return yield* withBytesStep(new Uint8Array(bytes.buffer, 0, units * 4), at=>set(effect,
            thread, setter, [constant.index, at, count]));
    };

    /**
     * Every state of a pass set, then the lights and the material its states built.
     *
     * @param {EffectState} effect @param {Pass} pass @param {boolean} all @param {any} thread
     * @param {number} [keep]
     */
    const applyPass = function*(effect, pass, all, thread, keep = 0){
        const now = clock++;
        let answer = D3D_OK;
        for (const state of pass.model.states)
        {
            const result = yield* applyState(effect, pass, state, -1, all, thread, keep);
            answer = result !== D3D_OK ? result : answer;
        }
        for (let i = 0; i < effect.lights.length; i++)
        {
            if (effect.lightsUpdated & (1 << i))
            {
                const result = yield* withBytesStep(effect.lights[i], at=>set(effect, thread,
                    'SetLight', [i, at]));
                answer = result !== D3D_OK ? result : answer;
            }
        }
        effect.lightsUpdated = 0;
        if (effect.materialUpdated)
        {
            const result = yield* withBytesStep(effect.material, at=>set(effect, thread,
                'SetMaterial', [at]));
            answer = result !== D3D_OK ? result : answer;
        }
        effect.materialUpdated = false;
        pass.applied = now;
        return answer;
    };

    /** @param {EffectState} effect @param {Technique} t */
    const valid = (effect, t)=>t.passes.every(pass=>pass.model.states.every(state=>{
        if (state.kind !== 'vs' && state.kind !== 'ps')
        {
            return true;
        }
        if (state.source.kind === 'shader')
        {
            return state.source.shader === null || effect.shaders[state.source.shader].ok;
        }
        const shader = shaderFor(effect, state);
        return !shader || shader.ok;
    }));

    /**
     * Whether a parameter is read by a technique: named by a state, under a
     * sampler a state or a shader uses, or a constant of one of its shaders.
     *
     * @param {EffectState} effect @param {Param} param @param {Technique} t
     */
    const used = (effect, param, t)=>{
        const root = param.top ?? param;
        /** @param {StateModel[]} states @returns {boolean} */
        const inStates = states=>states.some(state=>{
            if (state.source.kind === 'param')
            {
                const named = effect.byName.get(state.source.path);
                if (named && (named.top ?? named) === root)
                {
                    return true;
                }
                if (named && isSampler(named.model.type)
                    && named.model.samplers.some(list=>list && inStates(list)))
                {
                    return true;
                }
            }
            const shader = state.kind === 'vs' || state.kind === 'ps' ? shaderFor(effect, state)
                : null;
            return !!shader && shader.bindings.some(b=>b.param === root || (isSampler(
                b.param.model.type) && b.param.model.samplers.some(list=>list && inStates(list))));
        });
        return t.passes.some(pass=>inStates(pass.model.states));
    };

    // ---- the effect --------------------------------------------------------------------

    /** @param {any} object @returns {EffectState} */
    const stateOf = object=>object.state;

    /** @type {ComMethod[]} */
    const effectMethods = [
        /** HRESULT GetPool(LPD3DXEFFECTPOOL *) */
        { name: 'GetPool', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const effect = stateOf(object);
            putU32(out, effect.pool ? effect.poolPointer : 0);
            effect.pool?.addRef();
            return D3D_OK;
        } },
        /** HRESULT SetTechnique(D3DXHANDLE) */
        { name: 'SetTechnique', argBytes: 8, invoke: (object, [h])=>{
            const effect = stateOf(object);
            const t = techniqueOf(effect, h);
            if (!t)
            {
                return D3DERR_INVALIDCALL;
            }
            effect.current = t;
            return D3D_OK;
        } },
        /** D3DXHANDLE GetCurrentTechnique() */
        { name: 'GetCurrentTechnique', argBytes: 4, invoke: object=>
            stateOf(object).current?.handle ?? 0 },
        /** HRESULT ValidateTechnique(D3DXHANDLE) */
        { name: 'ValidateTechnique', argBytes: 8, invoke: (object, [h])=>{
            const effect = stateOf(object);
            const t = techniqueOf(effect, h);
            if (!t)
            {
                return D3DERR_INVALIDCALL;
            }
            return valid(effect, t) ? D3D_OK : E_FAIL;
        } },
        /** HRESULT FindNextValidTechnique(D3DXHANDLE hTechnique, D3DXHANDLE *pNext) */
        { name: 'FindNextValidTechnique', argBytes: 12, invoke: (object, [h, out])=>{
            const effect = stateOf(object);
            let from = 0;
            if ((h >>> 0) !== 0)
            {
                const t = techniqueOf(effect, h);
                if (!t)
                {
                    return D3DERR_INVALIDCALL;
                }
                from = effect.techniques.indexOf(t) + 1;
            }
            const next = effect.techniques.slice(from).find(t=>valid(effect, t));
            if ((out >>> 0) !== 0)
            {
                putU32(out, next?.handle ?? 0);
            }
            return next ? D3D_OK : S_FALSE;
        } },
        /** BOOL IsParameterUsed(D3DXHANDLE hParameter, D3DXHANDLE hTechnique) */
        { name: 'IsParameterUsed', argBytes: 12, invoke: (object, [h, ht])=>{
            const effect = stateOf(object);
            const p = paramOf(effect, h);
            const t = techniqueOf(effect, ht);
            return p && t && used(effect, p, t) ? 1 : 0;
        } },
        /** HRESULT Begin(UINT *pPasses, DWORD Flags) */
        { name: 'Begin', argBytes: 12, invoke: (object, [passesOut, flags])=>{
            const effect = stateOf(object);
            const t = effect.current;
            if (!t)
            {
                return D3DERR_INVALIDCALL;
            }
            if ((passesOut >>> 0) !== 0)
            {
                putU32(passesOut, t.passes.length);
            }
            effect.started = true;
            effect.beginFlags = flags >>> 0;
            if (flags & FX.DONOTSAVESTATE)
            {
                return D3D_OK;
            }
            return answerWith(saveState(effect, t, flags & (FX.DONOTSAVESHADERSTATE
                | FX.DONOTSAVESAMPLERSTATE), host.currentThread?.()));
        } },
        /** HRESULT BeginPass(UINT Pass) */
        { name: 'BeginPass', argBytes: 8, invoke: (object, [index])=>{
            const effect = stateOf(object);
            const t = effect.current;
            if (!effect.started || !t || (index >>> 0) >= t.passes.length || effect.active)
            {
                return D3DERR_INVALIDCALL;
            }
            const pass = t.passes[index >>> 0];
            effect.lights = [];
            effect.lightsUpdated = 0;
            effect.material = new Uint8Array(68);
            effect.materialUpdated = false;
            effect.active = pass;
            const thread = host.currentThread?.();
            return answerWith(function*(){
                const answer = yield* applyPass(effect, pass, true, thread);
                if (answer !== D3D_OK && effect.active === pass)
                {
                    effect.active = null;
                }
                return answer;
            }());
        } },
        /** HRESULT CommitChanges() */
        { name: 'CommitChanges', argBytes: 4, invoke: object=>{
            const effect = stateOf(object);
            const pass = effect.active;
            if (!pass)
            {
                return D3D_OK;
            }
            const thread = host.currentThread?.();
            return answerWith(applyPass(effect, pass, false, thread));
        } },
        /** HRESULT EndPass() */
        { name: 'EndPass', argBytes: 4, invoke: object=>{
            const effect = stateOf(object);
            if (!effect.active)
            {
                return D3DERR_INVALIDCALL;
            }
            effect.active = null;
            return D3D_OK;
        } },
        /** HRESULT End() */
        { name: 'End', argBytes: 4, invoke: object=>{
            const effect = stateOf(object);
            if (!effect.started)
            {
                return D3D_OK;
            }
            effect.started = false;
            const t = effect.current;
            const block = t?.saved.get(effect.beginFlags & (FX.DONOTSAVESHADERSTATE
                | FX.DONOTSAVESAMPLERSTATE));
            if ((effect.beginFlags & FX.DONOTSAVESTATE) || !block)
            {
                return D3D_OK;
            }
            const thread = host.currentThread?.();
            return answerWith(function*(){
                yield* methodStep(thread, block, STATEBLOCK.Apply, []);
                return D3D_OK;
            }());
        } },
        /** HRESULT GetDevice(LPDIRECT3DDEVICE9 *) */
        { name: 'GetDevice', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const device = stateOf(object).device;
            putU32(out, device);
            return addRefLater(host.currentThread?.(), device);
        } },
        /**
         * HRESULT OnLostDevice()
         *
         * The textures in the default pool let go of, as D3DX lets go of them, and the
         * state blocks it recorded released: a device is reset only once nothing in
         * its default pool and no state block is left.
         */
        { name: 'OnLostDevice', argBytes: 4, invoke: object=>{
            const effect = stateOf(object);
            const thread = host.currentThread?.();
            return Promise.resolve().then(()=>lose(effect, thread));
        } },
        /** HRESULT OnResetDevice() */
        { name: 'OnResetDevice', argBytes: 4, invoke: ()=>D3D_OK },
        /** HRESULT SetStateManager(LPD3DXEFFECTSTATEMANAGER) */
        { name: 'SetStateManager', argBytes: 8, invoke: (object, [manager])=>{
            const effect = stateOf(object);
            const old = effect.manager;
            effect.manager = manager >>> 0;
            const thread = host.currentThread?.();
            return Promise.resolve()
                .then(()=>(manager ? method(thread, manager >>> 0, 1, []) : 0))
                .then(()=>(old ? method(thread, old, UNKNOWN_RELEASE, []) : 0))
                .then(()=>D3D_OK);
        } },
        /** HRESULT GetStateManager(LPD3DXEFFECTSTATEMANAGER *) */
        { name: 'GetStateManager', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const manager = stateOf(object).manager;
            putU32(out, manager);
            return addRefLater(host.currentThread?.(), manager);
        } },
        /** HRESULT BeginParameterBlock() */
        { name: 'BeginParameterBlock', argBytes: 4, invoke: object=>{
            const effect = stateOf(object);
            if (effect.recording)
            {
                return D3DERR_INVALIDCALL;
            }
            effect.recording = [];
            return D3D_OK;
        } },
        /** D3DXHANDLE EndParameterBlock() */
        { name: 'EndParameterBlock', argBytes: 4, invoke: object=>{
            const effect = stateOf(object);
            const recorded = effect.recording;
            if (!recorded)
            {
                return 0;
            }
            effect.recording = null;
            const handle = heap().allocate(4);
            if (handle === 0)
            {
                return 0;
            }
            effect.owned.push(handle);
            effect.blocks.set(handle, recorded);
            handles.set(handle, { kind: 'block' });
            return handle;
        } },
        /** HRESULT ApplyParameterBlock(D3DXHANDLE) */
        { name: 'ApplyParameterBlock', argBytes: 8, invoke: (object, [h])=>{
            const block = stateOf(object).blocks.get(h >>> 0);
            if (!block || block.length === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            for (const { param, bytes } of block)
            {
                const view = new DataView(bytes.buffer);
                writeWords(param, Array.from({ length: bytes.length >>> 2 }, (_, i)=>
                    view.getUint32(i * 4, true)));
            }
            return D3D_OK;
        } },
        ...(version >= 26 ? [/** @type {ComMethod} */({
            /** HRESULT DeleteParameterBlock(D3DXHANDLE) */
            name: 'DeleteParameterBlock', argBytes: 8, invoke: (object, [h])=>{
                const effect = stateOf(object);
                if (!effect.blocks.delete(h >>> 0))
                {
                    return D3DERR_INVALIDCALL;
                }
                handles.delete(h >>> 0);
                return D3D_OK;
            } })] : []),
        /** HRESULT CloneEffect(LPDIRECT3DDEVICE9, LPD3DXEFFECT *) */
        { name: 'CloneEffect', argBytes: 12, invoke: (object, [device, out])=>{
            const effect = stateOf(object);
            if ((out >>> 0) !== 0)
            {
                putU32(out, 0);
            }
            if ((device >>> 0) === 0 || (out >>> 0) === 0 || (effect.flags & FX.NOT_CLONEABLE))
            {
                return D3DERR_INVALIDCALL;
            }
            const thread = host.currentThread?.();
            return Promise.resolve().then(()=>clone(effect, device >>> 0, out, thread));
        } },
        ...(version >= 27 ? [/** @type {ComMethod} */({
            /** HRESULT SetRawValue(D3DXHANDLE, LPCVOID pData, UINT ByteOffset, UINT Bytes) */
            name: 'SetRawValue', argBytes: 20, invoke: (object, [h, data, offset, bytes])=>{
                const p = paramOf(stateOf(object), h);
                if (!p || (data >>> 0) === 0 || (offset >>> 0) + (bytes >>> 0) > p.model.bytes
                    || !numeric(p) || (offset & 3) !== 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                writeWords(p, words(data, (bytes >>> 0) >>> 2), (offset >>> 0) >>> 2);
                return D3D_OK;
            } })] : []),
    ];

    /**
     * What Begin keeps: a state block recording every state of the technique's
     * passes, made the first time and captured each time.
     *
     * @param {EffectState} effect @param {Technique} t @param {number} keep @param {any} thread
     */
    const saveState = function*(effect, t, keep, thread){
        let block = t.saved.get(keep) ?? 0;
        if (!block)
        {
            const manager = effect.manager;
            effect.manager = 0;
            try
            {
                yield* methodStep(thread, effect.device, DEVICE_MORE.BeginStateBlock, []);
                for (const pass of t.passes)
                {
                    yield* applyPass(effect, pass, true, thread, keep);
                }
                block = Number(yield* withBytesStep(new Uint8Array(4), function*(at){
                    const answer = yield* methodStep(thread, effect.device,
                        DEVICE_MORE.EndStateBlock, [at]);
                    return answer === D3D_OK ? u32(at) : 0;
                }));
            }
            finally
            {
                effect.manager = manager;
            }
            if (block)
            {
                t.saved.set(keep, block);
            }
        }
        if (block)
        {
            yield* methodStep(thread, block, STATEBLOCK.Capture, []);
        }
        return D3D_OK;
    };

    /**
     * OnLostDevice's work.
     *
     * @param {EffectState} effect @param {any} thread
     */
    const lose = async(effect, thread)=>{
        for (const p of effect.params)
        {
            if (!isTexture(p.model.type) || p.model.elements)
            {
                continue;
            }
            const texture = wordsOf(p)[0];
            if (!texture)
            {
                continue;
            }
            // A word that names no object -- its table has no GetLevelDesc --
            // is said and left, not called through.
            let slot = 0;
            try
            {
                slot = u32(u32(texture) + TEXTURE_GETLEVELDESC * 4);
            }
            catch (e){
                void e;
            }
            if (slot === 0)
            {
                host.divergence?.('ID3DXEffect::OnLostDevice', `parameter ${p.model.name} holds`
                    + ` 0x${(texture >>> 0).toString(16)}, which is no texture: left as it is`);
                continue;
            }
            const pool = await withBytes(new Uint8Array(32), async at=>{
                const answer = await method(thread, texture, TEXTURE_GETLEVELDESC, [0, at]);
                return answer === D3D_OK ? u32(at + 12) : -1;
            });
            if (pool === 0)
            {
                writeWords(p, [0]);
            }
        }
        for (const t of effect.techniques)
        {
            for (const block of t.saved.values())
            {
                let release = 0;
                try
                {
                    release = u32(u32(block) + UNKNOWN_RELEASE * 4);
                }
                catch (e){
                    void e;
                }
                if (release === 0)
                {
                    host.divergence?.('ID3DXEffect::OnLostDevice', `technique ${t.model.name}`
                        + ` saved 0x${(block >>> 0).toString(16)}, which is no state block`);
                    continue;
                }
                await method(thread, block, UNKNOWN_RELEASE, []);
            }
            t.saved.clear();
        }
        return D3D_OK;
    };

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const effectInterface = {
        id: version <= 25 ? IID_ID3DXEFFECT_25 : version === 26 ? IID_ID3DXEFFECT_26
            : IID_ID3DXEFFECT,
        methods: [...baseMethods(), ...effectMethods],
    };

    // ---- the effect compiler ----------------------------------------------------------

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const compilerInterface = {
        id: IID_ID3DXEFFECTCOMPILER,
        methods: [
            ...baseMethods(),
            /** HRESULT SetLiteral(D3DXHANDLE, BOOL) */
            { name: 'SetLiteral', argBytes: 12, invoke: (object, [h, literal])=>{
                const p = paramOf(stateOf(object), h);
                if (!p || p.top !== p)
                {
                    return D3DERR_INVALIDCALL;
                }
                p.flags = literal ? p.flags | PARAMETER.LITERAL : p.flags & ~PARAMETER.LITERAL;
                return D3D_OK;
            } },
            /** HRESULT GetLiteral(D3DXHANDLE, BOOL *) */
            { name: 'GetLiteral', argBytes: 12, invoke: (object, [h, out])=>{
                const p = paramOf(stateOf(object), h);
                if (!p || p.top !== p || (out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32(out, p.flags & PARAMETER.LITERAL ? 1 : 0);
                return D3D_OK;
            } },
            /**
             * HRESULT CompileEffect(DWORD Flags, LPD3DXBUFFER *ppEffect,
             *     LPD3DXBUFFER *ppErrorMsgs)
             *
             * The effect as this layer's container rather than fx_2_0: what
             * D3DXCreateEffect needs to read it again.
             */
            { name: 'CompileEffect', argBytes: 16, invoke: (object, [flags, out, errors])=>{
                if ((errors >>> 0) !== 0)
                {
                    putU32(errors, 0);
                }
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32(out, 0);
                const origin = stateOf(object).origin;
                host.divergence?.('ID3DXEffectCompiler::CompileEffect', 'the compiled effect is '
                    + 'this layer\'s own container of the source, not fx_2_0 bytecode');
                return helpers.giveBuffer(out, containerOf({ ...origin,
                    flags: origin.flags | (flags >>> 0) }));
            } },
            /**
             * HRESULT CompileShader(D3DXHANDLE hFunction, LPCSTR pTarget, DWORD Flags,
             *     LPD3DXBUFFER *ppShader, LPD3DXBUFFER *ppErrorMsgs,
             *     LPD3DXCONSTANTTABLE *ppConstantTable)
             */
            { name: 'CompileShader', argBytes: 28,
                invoke: (object, [fn, target, flags, shaderOut, errorsOut, tableOut])=>{
                    for (const out of [shaderOut, errorsOut, tableOut])
                    {
                        if ((out >>> 0) !== 0)
                        {
                            putU32(out, 0);
                        }
                    }
                    const effect = stateOf(object);
                    const found = functionOf(effect, fn);
                    if (!found || (target >>> 0) === 0 || (shaderOut >>> 0) === 0)
                    {
                        return D3DERR_INVALIDCALL;
                    }
                    const origin = effect.origin;
                    return compileShader(origin.source, { entry: found.name,
                        profile: cString(target), flags: flags >>> 0, defines: origin.defines,
                        include: replay(origin.files) }).then(result=>{
                        if ((errorsOut >>> 0) !== 0 && result.messages !== '')
                        {
                            helpers.giveBuffer(errorsOut, encode(result.messages));
                        }
                        if (!result.ok || !result.tokens)
                        {
                            return E_FAIL;
                        }
                        const answer = helpers.giveBuffer(shaderOut, new Uint8Array(
                            result.tokens.buffer, result.tokens.byteOffset,
                            result.tokens.byteLength));
                        if (answer !== D3D_OK || (tableOut >>> 0) === 0 || !result.constantTable)
                        {
                            return answer;
                        }
                        return helpers.publishConstantTable(result.constantTable,
                            result.tokens[0], tableOut);
                    });
                } },
        ],
    };

    /** @param {{ name: string, system: boolean, text: string }[]} files */
    const replay = files=>(/** @type {string} */ name, /** @type {boolean} */ system)=>
        files.find(f=>f.name === name && f.system === system)?.text
        ?? files.find(f=>f.name === name)?.text ?? null;

    /**
     * This layer's compiled effect: the tag, then the source, its macros, its
     * included files and its flags as JSON.
     *
     * @param {EffectState['origin']} origin
     */
    const containerOf = origin=>{
        const json = JSON.stringify({ source: origin.source, defines: origin.defines,
            files: origin.files, flags: origin.flags });
        const bytes = new Uint8Array(8 + json.length);
        new DataView(bytes.buffer).setUint32(0, CONTAINER, true);
        new DataView(bytes.buffer).setUint32(4, 1, true);
        for (let i = 0; i < json.length; i++)
        {
            bytes[8 + i] = json.charCodeAt(i) & 0xff;
        }
        return bytes;
    };

    // ---- the pool ----------------------------------------------------------------------

    /**
     * @typedef {Object} SharedEntry
     * @property {ParamModel} model
     * @property {Store} store
     * @property {number} count   How many effects hold it.
     */

    /** Pools by the pointer a program holds. @type {Map<number, any>} */
    const pools = new Map();

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const poolInterface = { id: IID_ID3DXEFFECTPOOL, methods: [] };

    /**
     * Whether two parameters are the same to a pool: name, class, type, shape and
     * the same of their members.
     *
     * @param {ParamModel} a @param {ParamModel} b
     * @returns {boolean}
     */
    const sameParameter = (a, b)=>a.name === b.name && a.cls === b.cls && a.type === b.type
        && a.rows === b.rows && a.columns === b.columns && a.elements === b.elements
        && a.members.length === b.members.length && a.members.every((m, i)=>sameParameter(m,
        b.members[i]));

    // ---- making an effect ---------------------------------------------------------------

    /**
     * The objects of an effect over its model: parameters with their defaults (or
     * the pool's values for shared ones), techniques, passes, functions, and the
     * shaders made on the device.
     *
     * @param {EffectModel} model @param {EffectState['origin']} origin
     * @param {{ kind: 'effect' | 'compiler', device: number, pool: any, poolPointer: number,
     *     flags: number, skip: Set<string>, thread: any }} how
     * @returns {Promise<EffectState>}
     */
    const instantiate = async(model, origin, how)=>{
        /** @type {EffectState} */
        const effect = { kind: how.kind, model, origin, device: how.device, pool: how.pool,
            poolPointer: how.poolPointer, flags: how.flags, params: [], byName: new Map(),
            techniques: [], current: null, shaders: [], shaderByPointer: new Map(), functions: [],
            started: false, beginFlags: 0, active: null, manager: 0, lights: [],
            lightsUpdated: 0, material: new Uint8Array(68), materialUpdated: false,
            recording: null, blocks: new Map(), owned: [], skip: how.skip, version };
        if (!creatorAt)
        {
            [creatorAt] = strings([], [CREATOR]);
        }
        try
        {
            if (how.kind === 'effect')
            {
                for (const shader of model.shaders)
                {
                    effect.shaders.push(await makeShader(effect, shader, how.thread));
                }
            }
            for (const p of model.parameters)
            {
                const top = makeParam(effect, p, p.name, null, newStore(p.bytes), 0);
                top.top = top;
                setTop(top, top);
                fillDefaults(top);
                effect.params.push(top);
            }
            joinPool(effect);
            for (const shader of effect.shaders)
            {
                bindShader(effect, shader);
            }
            effect.techniques = model.techniques.map(t=>{
                const [handle] = strings(effect.owned, [t.name ?? '']);
                /** @type {Technique} */
                const technique = { model: t, handle, nameAt: t.name === null ? 0 : handle,
                    annotations: t.annotations.map(a=>annotationOf(effect, a, null)),
                    passes: t.passes.map(pass=>{
                        const [passHandle] = strings(effect.owned, [pass.name ?? '']);
                        handles.set(passHandle, { kind: 'pass' });
                        return { model: pass, handle: passHandle,
                            nameAt: pass.name === null ? 0 : passHandle,
                            annotations: pass.annotations.map(a=>annotationOf(effect, a, null)),
                            applied: 0 };
                    }),
                    saved: new Map() };
                handles.set(handle, { kind: 'technique' });
                return technique;
            });
            effect.current = effect.techniques[0] ?? null;
            effect.functions = how.kind === 'compiler' ? model.functions.map(name=>{
                const [handle] = strings(effect.owned, [name]);
                handles.set(handle, { kind: 'function' });
                return { handle, nameAt: handle, name };
            }) : [];
        }
        catch (e){
            destroy(effect);
            throw e;
        }
        return effect;
    };

    /** @param {Param} p @param {Param} top */
    const setTop = (p, top)=>{
        p.top = top;
        p.members.forEach(m=>setTop(m, top));
    };

    /**
     * The shared parameters of an effect take the pool's store when the pool has
     * one like it, and give theirs to the pool when not.
     *
     * @param {EffectState} effect
     */
    const joinPool = effect=>{
        if (!effect.pool)
        {
            return;
        }
        /** @type {SharedEntry[]} */
        const shared = effect.pool.state.shared;
        for (const top of effect.params)
        {
            if (!(top.flags & PARAMETER.SHARED) || isSampler(top.model.type))
            {
                continue;
            }
            const entry = shared.find(one=>one.count > 0 && sameParameter(one.model, top.model));
            if (entry)
            {
                entry.count++;
                top.store.strings.forEach(at=>heap().free(at));
                retarget(top, entry.store);
            }
            else
            {
                shared.push({ model: top.model, store: top.store, count: 1 });
            }
        }
    };

    /** @param {Param} p @param {Store} store */
    const retarget = (p, store)=>{
        p.store = store;
        p.members.forEach(m=>retarget(m, store));
    };

    /**
     * A shader of the effect made on the device, with a copy of its bytecode.
     *
     * @param {EffectState} effect @param {import('./effect-model.js').ShaderModel} model
     * @param {any} thread
     * @returns {Promise<Shader>}
     */
    const makeShader = async(effect, model, thread)=>{
        /** @type {Shader} */
        const shader = { pointer: 0, pixel: model.pixel, ok: false, tokensAt: 0, bindings: [] };
        if (!model.tokens)
        {
            // Said with the compiler's own first error: a technique left
            // invalid by it is otherwise only "a shader did not compile".
            const first = model.messages.split('\n').find(line=>/error/i.test(line))
                ?? model.messages.split('\n')[0];
            host.divergence?.('D3DXCreateEffect', `the ${model.profile} shader of`
                + ` '${model.entry}' did not compile: ${first || 'no message'}`);
            return shader;
        }
        const bytes = new Uint8Array(model.tokens.buffer, model.tokens.byteOffset,
            model.tokens.byteLength);
        const at = heap().allocate(bytes.length);
        if (at === 0)
        {
            return shader;
        }
        effect.owned.push(at);
        host.writeMemory(at, bytes);
        shader.tokensAt = at;
        const pointer = await withBytes(new Uint8Array(4), async out=>{
            const answer = await method(thread, effect.device, model.pixel
                ? DEVICE_MORE.CreatePixelShader : DEVICE_MORE.CreateVertexShader, [at, out]);
            return answer === D3D_OK ? u32(out) : 0;
        });
        shader.pointer = Number(pointer);
        shader.ok = shader.pointer !== 0;
        if (!shader.ok)
        {
            host.divergence?.('D3DXCreateEffect', `the device refused the ${model.profile} shader `
                + `of '${model.entry}'`);
        }
        else
        {
            effect.shaderByPointer.set(shader.pointer, shader);
        }
        return shader;
    };

    /**
     * Which parameter each constant of a shader is set from: the top-level
     * parameter of the constant's name.
     *
     * @param {EffectState} effect @param {Shader} shader
     */
    const bindShader = (effect, shader)=>{
        const index = effect.shaders.indexOf(shader);
        const block = effect.model.shaders[index]?.constantTable;
        if (!block)
        {
            return;
        }
        const { constants } = parseConstantTable(new DataView(block.buffer, block.byteOffset,
            block.byteLength), 0);
        for (const constant of constants)
        {
            const param = effect.byName.get(constant.name);
            if (param && param.top === param)
            {
                shader.bindings.push({ constant, param });
            }
        }
    };

    /**
     * Lets go of what an effect holds host-side: its heap blocks, its handles and
     * its share of the pool's parameters.
     *
     * @param {EffectState} effect
     */
    const destroy = effect=>{
        /** @param {Param} p */
        const forget = p=>{
            handles.delete(p.handle);
            p.members.forEach(forget);
            forgetAnnotations(p.annotations);
        };
        /** Annotations have stores of their own. @param {Param[]} list */
        const forgetAnnotations = list=>list.forEach(annotation=>{
            forget(annotation);
            annotation.store.strings.forEach(at=>heap().free(at));
        });
        effect.params.forEach(forget);
        for (const t of effect.techniques)
        {
            handles.delete(t.handle);
            forgetAnnotations(t.annotations);
            for (const pass of t.passes)
            {
                handles.delete(pass.handle);
                forgetAnnotations(pass.annotations);
            }
        }
        effect.functions.forEach(f=>handles.delete(f.handle));
        effect.blocks.forEach((_, h)=>handles.delete(h));
        /** @type {SharedEntry[]} */
        const shared = effect.pool?.state.shared ?? [];
        for (const top of effect.params)
        {
            const entry = shared.find(one=>one.store === top.store);
            if (entry)
            {
                entry.count--;
                if (entry.count > 0)
                {
                    continue;
                }
                shared.splice(shared.indexOf(entry), 1);
            }
            top.store.strings.forEach(at=>heap().free(at));
        }
        effect.pool?.release();
        effect.pool = null;
        effect.owned.forEach(at=>heap().free(at));
        effect.owned = [];
    };

    /**
     * An effect's COM object, published, its pointer written to `out`.
     *
     * @param {EffectState} effect @param {number} out
     */
    const publishEffect = (effect, out)=>{
        const vtables = /** @type {NonNullable<EffectHost['vtables']>} */ (host.vtables);
        const object = createComObject(effectInterface.id, { interfaces: [effectInterface],
            state: effect, destroy: ()=>destroy(effect) });
        const pointer = vtables.publish(object, effectInterface.id) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        putU32(out, pointer);
        return D3D_OK;
    };

    /**
     * CloneEffect's work: the same effect on another device, its values copied.
     *
     * @param {EffectState} effect @param {number} device @param {number} out @param {any} thread
     */
    const clone = async(effect, device, out, thread)=>{
        effect.pool?.addRef();
        const copy = await instantiate(effect.model, effect.origin, { kind: 'effect', device,
            pool: effect.pool, poolPointer: effect.poolPointer, flags: effect.flags,
            skip: effect.skip, thread });
        effect.params.forEach((p, i)=>{
            const target = copy.params[i];
            if (target.store === p.store || isShader(p.model.type))
            {
                return;
            }
            new Uint8Array(target.store.view.buffer, target.offset, p.model.bytes).set(
                new Uint8Array(p.store.view.buffer, p.offset, p.model.bytes));
            for (const [at, copyAt] of p.store.strings)
            {
                if (at >= p.offset && at < p.offset + p.model.bytes)
                {
                    writeString(target.store, at, cString(copyAt));
                }
            }
        });
        copy.current = copy.techniques[effect.techniques.indexOf(
            /** @type {Technique} */ (effect.current))] ?? copy.techniques[0] ?? null;
        return publishEffect(copy, out);
    };

    /** Built effects, by everything that went into them. @type {Map<string, any>} */
    const built = new Map();
    const BUILT_KEPT = 64;

    /**
     * An effect's model from its source: built, or the one built before from the
     * same source, macros and flags once its includes are found the same.
     *
     * @param {string} source @param {[string, string][]} defines
     * @param {((name: string, system: boolean) => Promise<string | null> | string | null)
     *     | undefined} include
     * @param {number} flags @param {boolean} compile
     * @returns {Promise<import('./effect-model.js').BuildResult>}
     */
    const buildOnce = async(source, defines, include, flags, compile)=>{
        // The include is a call into the guest, which the bridge takes only once the
        // handler has returned.
        await null;
        const key = JSON.stringify([source, defines, flags, compile, !!include]);
        const known = built.get(key);
        if (known)
        {
            let same = true;
            for (const file of known.files)
            {
                if ((include ? await include(file.name, file.system) : null) !== file.text)
                {
                    same = false;
                    break;
                }
            }
            if (same)
            {
                return known;
            }
        }
        const result = await buildEffect(source, { defines, include, flags, compile,
            compiled: record=>host.shaderCompiled?.({ api: 'ID3DXEffect', profile: record.profile,
                entry: record.entry, defines, flags, source, included: {},
                messages: record.messages, tokens: record.tokens }) });
        built.delete(key);
        built.set(key, result);
        if (built.size > BUILT_KEPT)
        {
            built.delete(/** @type {string} */ (built.keys().next().value));
        }
        return result;
    };

    /**
     * The source an effect is made from, out of what a program handed over: its
     * text, or this layer's container; a compiled fx_2_0 effect is refused.
     *
     * @param {Uint8Array} bytes
     * @returns {{ source: string, defines?: [string, string][], files?: any[], flags?: number }
     *     | null}
     */
    const sourceOf = bytes=>{
        const tag = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4)
            .getUint32(0, true) : 0;
        if (tag === FX_2_0)
        {
            return null;
        }
        if (tag === CONTAINER)
        {
            try
            {
                return JSON.parse(latin1(bytes.subarray(8)));
            }
            catch {
                return null;
            }
        }
        const end = bytes.indexOf(0);
        return { source: latin1(end < 0 ? bytes : bytes.subarray(0, end)) };
    };

    /**
     * D3DXCreateEffectEx's work, for every function that makes an effect: the
     * source to a model, the model to the objects, the pointer to `out`, the
     * compiler's messages to `errorsOut`.
     *
     * @param {string} api
     * @param {{ device: number, bytes: Uint8Array | null, defines: number, include: number,
     *     skip: number, flags: number, pool: number, out: number, errors: number }} a
     * @returns {number | Promise<number>}
     */
    const createEffect = (api, a)=>{
        for (const out of [a.out, a.errors])
        {
            if ((out >>> 0) !== 0)
            {
                putU32(out, 0);
            }
        }
        if ((a.device >>> 0) === 0 || !a.bytes || !host.heap || !host.vtables || !host.callGuest)
        {
            return D3DERR_INVALIDCALL;
        }
        if (a.bytes.length === 0)
        {
            return E_FAIL;
        }
        if ((a.out >>> 0) === 0)
        {
            return D3D_OK;
        }
        const given = sourceOf(a.bytes);
        if (!given)
        {
            host.divergence?.(api, 'answered E_NOTIMPL: a compiled fx_2_0 effect is not read, '
                + 'only HLSL source');
            return E_NOTIMPL;
        }
        const thread = host.currentThread?.();
        const defines = given.defines ?? helpers.macrosAt(a.defines);
        const include = given.files ? replay(given.files) : (a.include >>> 0) === 0 ? undefined
            : helpers.includer(a.include >>> 0);
        const flags = (given.flags ?? 0) | (a.flags >>> 0);
        const pool = (a.pool >>> 0) === 0 ? null : pools.get(a.pool >>> 0) ?? null;
        if ((a.pool >>> 0) !== 0 && !pool)
        {
            return D3DERR_INVALIDCALL;
        }
        const skip = new Set((a.skip >>> 0) === 0 ? [] : cString(a.skip).split(/[;\s]+/)
            .filter(name=>name !== ''));
        return buildOnce(given.source, defines, include, flags & 0xffff, true)
            .then(async result=>{
                host.shaderCompiled?.({ api, profile: 'fx', entry: 'effect', defines, flags,
                    source: given.source, included: Object.fromEntries(result.files.map(f=>
                        [f.name, f.text])), messages: result.messages, tokens: null });
                if ((a.errors >>> 0) !== 0 && result.messages !== '')
                {
                    helpers.giveBuffer(a.errors, encode(result.messages));
                }
                if (!result.model)
                {
                    const first = result.messages.split('\n').find(line=>/ error /.test(line))
                        ?? result.messages.split('\n')[0];
                    host.divergence?.(api, `refused: ${first}`);
                    return E_FAIL;
                }
                if (result.messages.includes(' warning X4709') || result.messages.includes(
                    ' warning X4708'))
                {
                    host.divergence?.(api, `states left out: ${result.messages.split('\n')
                        .filter(line=>/ X470[89]/.test(line)).join('; ')}`);
                }
                pool?.addRef();
                let effect;
                try
                {
                    effect = await instantiate(result.model, { source: given.source, defines,
                        files: result.files, flags: flags & 0xffff }, { kind: 'effect',
                        device: a.device >>> 0, pool, poolPointer: a.pool >>> 0,
                        flags: flags >>> 0, skip, thread });
                }
                catch (e){
                    if (e instanceof RangeError)
                    {
                        return E_OUTOFMEMORY;
                    }
                    throw e;
                }
                for (const t of effect.techniques)
                {
                    if (!valid(effect, t))
                    {
                        host.divergence?.(api, `technique '${t.model.name}' is not valid here: `
                            + 'a shader of it did not compile or was refused');
                    }
                }
                return publishEffect(effect, a.out);
            });
    };

    /**
     * D3DXCreateEffectCompiler's work.
     *
     * @param {string} api
     * @param {{ bytes: Uint8Array | null, defines: number, include: number, flags: number,
     *     out: number, errors: number }} a
     * @returns {number | Promise<number>}
     */
    const createCompiler = (api, a)=>{
        for (const out of [a.out, a.errors])
        {
            if ((out >>> 0) !== 0)
            {
                putU32(out, 0);
            }
        }
        if (!a.bytes || (a.out >>> 0) === 0 || !host.heap || !host.vtables)
        {
            return D3DERR_INVALIDCALL;
        }
        const given = sourceOf(a.bytes);
        if (!given)
        {
            host.divergence?.(api, 'answered E_NOTIMPL: a compiled fx_2_0 effect is not read');
            return E_NOTIMPL;
        }
        const defines = given.defines ?? helpers.macrosAt(a.defines);
        const include = given.files ? replay(given.files) : (a.include >>> 0) === 0 ? undefined
            : helpers.includer(a.include >>> 0);
        const flags = (given.flags ?? 0) | (a.flags >>> 0);
        return buildOnce(given.source, defines, include, flags & 0xffff, false)
            .then(async result=>{
                host.shaderCompiled?.({ api, profile: 'fx', entry: 'effect', defines, flags,
                    source: given.source, included: Object.fromEntries(result.files.map(f=>
                        [f.name, f.text])), messages: result.messages, tokens: null });
                if ((a.errors >>> 0) !== 0 && result.messages !== '')
                {
                    helpers.giveBuffer(a.errors, encode(result.messages));
                }
                if (!result.model)
                {
                    host.divergence?.(api, `refused: ${result.messages.split('\n')[0]}`);
                    return E_FAIL;
                }
                const effect = await instantiate(result.model, { source: given.source, defines,
                    files: result.files, flags: flags & 0xffff }, { kind: 'compiler', device: 0,
                    pool: null, poolPointer: 0, flags: flags >>> 0, skip: new Set(),
                    thread: undefined });
                const vtables = /** @type {NonNullable<EffectHost['vtables']>} */ (host.vtables);
                const object = createComObject(IID_ID3DXEFFECTCOMPILER, {
                    interfaces: [compilerInterface], state: effect, destroy: ()=>destroy(effect) });
                const pointer = vtables.publish(object, IID_ID3DXEFFECTCOMPILER) >>> 0;
                if (pointer === 0)
                {
                    object.release();
                    return E_OUTOFMEMORY;
                }
                putU32(a.out, pointer);
                return D3D_OK;
            });
    };

    /**
     * A file's bytes for the FromFile functions, through the host.
     *
     * @param {string} api @param {string} path
     * @returns {Promise<Uint8Array | null>}
     */
    const fileBytes = async(api, path)=>{
        if (!host.readFile)
        {
            host.divergence?.(api, 'answered D3DXERR_INVALIDDATA: no file reader is given to '
                + 'this layer');
            return null;
        }
        return host.readFile(path);
    };

    /**
     * A resource's bytes for the FromResource functions: RT_RCDATA, as D3DX looks
     * an effect up, else the type D3DX also accepts, "RCDATA"-less custom ones not.
     *
     * @param {string} api @param {number} module @param {string | number} name
     * @returns {Promise<Uint8Array | null>}
     */
    const resourceBytes = async(api, module, name)=>{
        if (!host.resource)
        {
            host.divergence?.(api, 'answered D3DXERR_INVALIDDATA: no resource reader is given '
                + 'to this layer');
            return null;
        }
        return host.resource(module, name, 10);
    };

    /** A resource name: an ordinal or a string. @param {number} at @param {boolean} wide */
    const resourceName = (at, wide)=>((at >>> 0) < 0x10000 ? at >>> 0
        : wide ? wideString(at) : cString(at));

    /**
     * The FromFile and FromResource functions: the bytes found, then as
     * D3DXCreateEffectEx; D3DXERR_INVALIDDATA when there are none.
     *
     * @param {string} api @param {Promise<Uint8Array | null>} found
     * @param {Omit<Parameters<typeof createEffect>[1], 'bytes'>} rest
     */
    const effectFrom = (api, found, rest)=>{
        for (const out of [rest.out, rest.errors])
        {
            if ((out >>> 0) !== 0)
            {
                putU32(out, 0);
            }
        }
        return found.then(bytes=>(bytes ? createEffect(api, { ...rest, bytes })
            : D3DXERR_INVALIDDATA));
    };

    /** @param {number} at @param {number} size */
    const bytesAt = (at, size)=>((at >>> 0) === 0 ? null
        : host.readMemory(at >>> 0, size >>> 0).slice());

    const exports = {
        /**
         * HRESULT D3DXCreateEffect(LPDIRECT3DDEVICE9, LPCVOID pSrcData, UINT SrcDataLen,
         *     CONST D3DXMACRO *, LPD3DXINCLUDE, DWORD Flags, LPD3DXEFFECTPOOL,
         *     LPD3DXEFFECT *ppEffect, LPD3DXBUFFER *ppCompilationErrors)
         */
        D3DXCreateEffect: { argBytes: 36, handler: (/** @type {number[]} */ [device, data, size,
            defines, include, flags, pool, out, errors])=>createEffect('D3DXCreateEffect', {
            device, bytes: bytesAt(data, size), defines, include, skip: 0, flags, pool, out,
            errors }) },
        /** The same, with the names of constants the effect does not set (LPCSTR, after the include). */
        D3DXCreateEffectEx: { argBytes: 40, handler: (/** @type {number[]} */ [device, data, size,
            defines, include, skip, flags, pool, out, errors])=>createEffect('D3DXCreateEffectEx', {
            device, bytes: bytesAt(data, size), defines, include, skip, flags, pool, out,
            errors }) },
        ...Object.fromEntries(['A', 'W'].flatMap(suffix=>{
            const wide = suffix === 'W';
            /** @param {number} at */
            const path = at=>(wide ? wideString(at) : cString(at));
            return [
                [`D3DXCreateEffectFromFile${suffix}`, { argBytes: 32,
                    handler: (/** @type {number[]} */ [device, file, defines, include, flags, pool,
                        out, errors])=>((device >>> 0) === 0 || (file >>> 0) === 0
                        ? D3DERR_INVALIDCALL : effectFrom(`D3DXCreateEffectFromFile${suffix}`,
                            fileBytes(`D3DXCreateEffectFromFile${suffix}`, path(file)),
                            { device, defines, include, skip: 0, flags, pool, out, errors })) }],
                [`D3DXCreateEffectFromFileEx${suffix}`, { argBytes: 36,
                    handler: (/** @type {number[]} */ [device, file, defines, include, skip, flags,
                        pool, out, errors])=>((device >>> 0) === 0 || (file >>> 0) === 0
                        ? D3DERR_INVALIDCALL : effectFrom(`D3DXCreateEffectFromFileEx${suffix}`,
                            fileBytes(`D3DXCreateEffectFromFileEx${suffix}`, path(file)),
                            { device, defines, include, skip, flags, pool, out, errors })) }],
                [`D3DXCreateEffectFromResource${suffix}`, { argBytes: 36,
                    handler: (/** @type {number[]} */ [device, module, name, defines, include,
                        flags, pool, out, errors])=>((device >>> 0) === 0 ? D3DERR_INVALIDCALL
                        : effectFrom(`D3DXCreateEffectFromResource${suffix}`, resourceBytes(
                            `D3DXCreateEffectFromResource${suffix}`, module, resourceName(name,
                                wide)), { device, defines, include, skip: 0, flags, pool, out,
                            errors })) }],
                [`D3DXCreateEffectFromResourceEx${suffix}`, { argBytes: 40,
                    handler: (/** @type {number[]} */ [device, module, name, defines, include,
                        skip, flags, pool, out, errors])=>((device >>> 0) === 0
                        ? D3DERR_INVALIDCALL : effectFrom(`D3DXCreateEffectFromResourceEx${suffix}`,
                            resourceBytes(`D3DXCreateEffectFromResourceEx${suffix}`, module,
                                resourceName(name, wide)), { device, defines, include, skip,
                                flags, pool, out, errors })) }],
                [`D3DXCreateEffectCompilerFromFile${suffix}`, { argBytes: 24,
                    handler: (/** @type {number[]} */ [file, defines, include, flags, out, errors])=>{
                        const api = `D3DXCreateEffectCompilerFromFile${suffix}`;
                        if ((file >>> 0) === 0 || (out >>> 0) === 0)
                        {
                            return D3DERR_INVALIDCALL;
                        }
                        putU32(out, 0);
                        return fileBytes(api, path(file)).then(bytes=>(bytes ? createCompiler(api,
                            { bytes, defines, include, flags, out, errors })
                            : D3DXERR_INVALIDDATA));
                    } }],
                [`D3DXCreateEffectCompilerFromResource${suffix}`, { argBytes: 28,
                    handler: (/** @type {number[]} */ [module, name, defines, include, flags, out,
                        errors])=>{
                        const api = `D3DXCreateEffectCompilerFromResource${suffix}`;
                        if ((out >>> 0) === 0)
                        {
                            return D3DERR_INVALIDCALL;
                        }
                        putU32(out, 0);
                        return resourceBytes(api, module, resourceName(name, wide)).then(bytes=>
                            (bytes ? createCompiler(api, { bytes, defines, include, flags, out,
                                errors }) : D3DXERR_INVALIDDATA));
                    } }],
            ];
        })),
        /** HRESULT D3DXCreateEffectPool(LPD3DXEFFECTPOOL *ppPool) */
        D3DXCreateEffectPool: { argBytes: 4, handler: (/** @type {number[]} */ [out])=>{
            if ((out >>> 0) === 0 || !host.vtables)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ pointer: number }} */
            const holder = { pointer: 0 };
            const object = createComObject(IID_ID3DXEFFECTPOOL, { interfaces: [poolInterface],
                state: { shared: [] }, destroy: ()=>pools.delete(holder.pointer) });
            holder.pointer = host.vtables.publish(object, IID_ID3DXEFFECTPOOL) >>> 0;
            if (holder.pointer === 0)
            {
                object.release();
                return E_OUTOFMEMORY;
            }
            pools.set(holder.pointer, object);
            putU32(out, holder.pointer);
            return D3D_OK;
        } },
        /**
         * HRESULT D3DXCreateEffectCompiler(LPCSTR pSrcData, UINT SrcDataLen,
         *     CONST D3DXMACRO *, LPD3DXINCLUDE, DWORD Flags,
         *     LPD3DXEFFECTCOMPILER *ppCompiler, LPD3DXBUFFER *ppParseErrors)
         */
        D3DXCreateEffectCompiler: { argBytes: 28, handler: (/** @type {number[]} */ [data, size,
            defines, include, flags, out, errors])=>createCompiler('D3DXCreateEffectCompiler', {
            bytes: bytesAt(data, size), defines, include, flags, out, errors }) },
        /** HRESULT D3DXDisassembleEffect(LPD3DXEFFECT, BOOL EnableColorCode, LPD3DXBUFFER *) */
        D3DXDisassembleEffect: { argBytes: 12, handler: (/** @type {number[]} */ [, , out])=>{
            if ((out >>> 0) !== 0)
            {
                putU32(out, 0);
            }
            host.divergence?.('D3DXDisassembleEffect', 'answered E_NOTIMPL: there is no fx_2_0 '
                + 'listing of an effect read from source');
            return E_NOTIMPL;
        } },
    };

    return { exports, effectInterface, compilerInterface, poolInterface };
}
