/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HLSL to a Direct3D 10 effect: the fx_4_0 and fx_4_1 profiles of D3DCompile and
 * D3D10CompileEffectFromMemory.
 *
 * An effect file is HLSL with an effect's own declarations in it: state objects with their
 * blocks (`BlendState b { SrcBlend = ONE; }`, a `SamplerState` with one), shader variables
 * (`VertexShader v = CompileShader(vs_4_0, f());`), and techniques of passes that set
 * shaders and states. Those are read here from the preprocessed text and taken out of it,
 * leaving HLSL the common front end checks; every numeric global, every constant buffer and
 * every object variable of the program goes into the effect, and each shader a pass or a
 * variable compiles is compiled by `compile.js` from the same text.
 *
 * What comes out is a container with one FX10 chunk, laid out as `graphics/d3d10/effect.js`
 * reads it and as fxc writes it: nineteen dwords of counts, an unstructured block of names,
 * types, default values, strings and shaders, then the constant buffers ($Globals always
 * first), the object variables and the techniques. A state or an index computed when the
 * effect runs (fxc writes expression code for those), a geometry shader, stream output, a
 * variable an effect pool shares and fx_5_0 are refused with a message.
 */

import { preprocessTracked } from '../../win32/d3dx9/preprocess.js';
import { HlslError, formatDiagnostic, tokenize } from '../../win32/d3dx9/hlsl-lexer.js';
import { parse } from '../../win32/d3dx9/hlsl-parser.js';
import { check } from '../../win32/d3dx9/hlsl-check.js';
import { withLineMarkers } from '../../win32/d3dx9/hlsl-compile.js';
import { arrayOf, baseOf, flatBases, flattenValue, fromTypeRef, scalarCount }
    from '../../win32/d3dx9/hlsl-types.js';
import { literalOf } from '../../win32/d3dx9/effect-model.js';
import { compileShader4 } from './compile.js';
import { layoutOf } from './hlsl4.js';
import { writeContainer } from './dxbc-write.js';

/** @typedef {import('../../win32/d3dx9/hlsl-types.js').Type} Type */

/** The effect profiles, and the version dword each writes. */
const VERSIONS = /** @type {Record<string, number>} */ ({ fx_4_0: 0xfeff1001,
    fx_4_1: 0xfeff1011 });

/** @param {string} name */
export const isEffectProfile = name=>Object.hasOwn(VERSIONS, name);

/** The object kinds of the file, by the HLSL type that declares them. */
const OBJECT_KIND = /** @type {Record<string, number>} */ ({
    String: 1, BlendState: 2, DepthStencilState: 3, RasterizerState: 4, PixelShader: 5,
    VertexShader: 6, GeometryShader: 7, texture: 9, Texture1D: 10, Texture1DArray: 11,
    Texture2D: 12, Texture2DArray: 13, Texture2DMS: 14, Texture2DMSArray: 15, Texture3D: 16,
    TextureCube: 17, RenderTargetView: 19, DepthStencilView: 20, SamplerState: 21,
    SamplerComparisonState: 21, Buffer: 22, TextureCubeArray: 23,
});

/** A texture's object type name by the checker's dimension. */
const TEXTURE_NAME = /** @type {Record<string, string>} */ ({ any: 'texture', '1d': 'Texture1D',
    '1darray': 'Texture1DArray', '2d': 'Texture2D', '2darray': 'Texture2DArray',
    '2dms': 'Texture2DMS', '2dmsarray': 'Texture2DMSArray', '3d': 'Texture3D',
    cube: 'TextureCube', cubearray: 'TextureCubeArray', buffer: 'Buffer' });

/**
 * The header's count each state object kind is counted in.
 *
 * @type {Record<number, 'blend' | 'depthStencil' | 'rasterizer' | 'samplers'>}
 */
const STATE_COUNT = { 2: 'blend', 3: 'depthStencil', 4: 'rasterizer', 21: 'samplers' };

/** The pass states, by the id the file stores. */
const PASS = Object.freeze({ RASTERIZER: 0, DEPTH_STENCIL: 1, BLEND: 2, VERTEX_SHADER: 6,
    PIXEL_SHADER: 7, GEOMETRY_SHADER: 8, STENCIL_REF: 9, BLEND_FACTOR: 0xa, SAMPLE_MASK: 0xb });

/** How an assignment says where its value comes from. */
const ASSIGN = Object.freeze({ CONSTANT: 1, VARIABLE: 2, CONSTANT_INDEX: 3,
    ANONYMOUS_SHADER: 7 });

/** A constant's type in an assignment. */
const CONSTANT = Object.freeze({ FLOAT: 1, INT: 2, UINT: 3, BOOL: 4 });

const BLEND = { ZERO: 1, ONE: 2, SRC_COLOR: 3, INV_SRC_COLOR: 4, SRC_ALPHA: 5,
    INV_SRC_ALPHA: 6, DEST_ALPHA: 7, INV_DEST_ALPHA: 8, DEST_COLOR: 9, INV_DEST_COLOR: 10,
    SRC_ALPHA_SAT: 11, BLEND_FACTOR: 14, INV_BLEND_FACTOR: 15, SRC1_COLOR: 16,
    INV_SRC1_COLOR: 17, SRC1_ALPHA: 18, INV_SRC1_ALPHA: 19 };
const BLEND_OP = { ADD: 1, SUBTRACT: 2, REV_SUBTRACT: 3, MIN: 4, MAX: 5 };
const COMPARISON = { NEVER: 1, LESS: 2, EQUAL: 3, LESS_EQUAL: 4, GREATER: 5, NOT_EQUAL: 6,
    GREATER_EQUAL: 7, ALWAYS: 8 };
const STENCIL_OP = { KEEP: 1, ZERO: 2, REPLACE: 3, INCR_SAT: 4, DECR_SAT: 5, INVERT: 6,
    INCR: 7, DECR: 8 };
const ADDRESS = { WRAP: 1, MIRROR: 2, CLAMP: 3, BORDER: 4, MIRROR_ONCE: 5 };
const FILTER = { MIN_MAG_MIP_POINT: 0, MIN_MAG_POINT_MIP_LINEAR: 1,
    MIN_POINT_MAG_LINEAR_MIP_POINT: 4, MIN_POINT_MAG_MIP_LINEAR: 5,
    MIN_LINEAR_MAG_MIP_POINT: 0x10, MIN_LINEAR_MAG_POINT_MIP_LINEAR: 0x11,
    MIN_MAG_LINEAR_MIP_POINT: 0x14, MIN_MAG_MIP_LINEAR: 0x15, ANISOTROPIC: 0x55,
    COMPARISON_MIN_MAG_MIP_POINT: 0x80, COMPARISON_MIN_MAG_POINT_MIP_LINEAR: 0x81,
    COMPARISON_MIN_POINT_MAG_LINEAR_MIP_POINT: 0x84, COMPARISON_MIN_POINT_MAG_MIP_LINEAR: 0x85,
    COMPARISON_MIN_LINEAR_MAG_MIP_POINT: 0x90, COMPARISON_MIN_LINEAR_MAG_POINT_MIP_LINEAR: 0x91,
    COMPARISON_MIN_MAG_LINEAR_MIP_POINT: 0x94, COMPARISON_MIN_MAG_MIP_LINEAR: 0x95,
    COMPARISON_ANISOTROPIC: 0xd5, TEXT_1BIT: 0x80000000 };

/**
 * The fields of the state blocks: the state id, the block, the enumeration its names come
 * from, whether it takes an index (a render target).
 *
 * @type {Record<string, { id: number, block: string, names?: Record<string, number>,
 *     indexed?: boolean, count?: number }>}
 */
const FIELDS = {
    FILLMODE: { id: 0x0c, block: 'rasterizer', names: { WIREFRAME: 2, SOLID: 3 } },
    CULLMODE: { id: 0x0d, block: 'rasterizer', names: { NONE: 1, FRONT: 2, BACK: 3 } },
    FRONTCOUNTERCLOCKWISE: { id: 0x0e, block: 'rasterizer' },
    DEPTHBIAS: { id: 0x0f, block: 'rasterizer' },
    DEPTHBIASCLAMP: { id: 0x10, block: 'rasterizer' },
    SLOPESCALEDDEPTHBIAS: { id: 0x11, block: 'rasterizer' },
    DEPTHCLIPENABLE: { id: 0x12, block: 'rasterizer' },
    SCISSORENABLE: { id: 0x13, block: 'rasterizer' },
    MULTISAMPLEENABLE: { id: 0x14, block: 'rasterizer' },
    ANTIALIASEDLINEENABLE: { id: 0x15, block: 'rasterizer' },
    DEPTHENABLE: { id: 0x16, block: 'depthstencil' },
    DEPTHWRITEMASK: { id: 0x17, block: 'depthstencil', names: { ZERO: 0, ALL: 1 } },
    DEPTHFUNC: { id: 0x18, block: 'depthstencil', names: COMPARISON },
    STENCILENABLE: { id: 0x19, block: 'depthstencil' },
    STENCILREADMASK: { id: 0x1a, block: 'depthstencil' },
    STENCILWRITEMASK: { id: 0x1b, block: 'depthstencil' },
    FRONTFACESTENCILFAIL: { id: 0x1c, block: 'depthstencil', names: STENCIL_OP },
    FRONTFACESTENCILDEPTHFAIL: { id: 0x1d, block: 'depthstencil', names: STENCIL_OP },
    FRONTFACESTENCILPASS: { id: 0x1e, block: 'depthstencil', names: STENCIL_OP },
    FRONTFACESTENCILFUNC: { id: 0x1f, block: 'depthstencil', names: COMPARISON },
    BACKFACESTENCILFAIL: { id: 0x20, block: 'depthstencil', names: STENCIL_OP },
    BACKFACESTENCILDEPTHFAIL: { id: 0x21, block: 'depthstencil', names: STENCIL_OP },
    BACKFACESTENCILPASS: { id: 0x22, block: 'depthstencil', names: STENCIL_OP },
    BACKFACESTENCILFUNC: { id: 0x23, block: 'depthstencil', names: COMPARISON },
    ALPHATOCOVERAGEENABLE: { id: 0x24, block: 'blend' },
    BLENDENABLE: { id: 0x25, block: 'blend', indexed: true },
    SRCBLEND: { id: 0x26, block: 'blend', names: BLEND },
    DESTBLEND: { id: 0x27, block: 'blend', names: BLEND },
    BLENDOP: { id: 0x28, block: 'blend', names: BLEND_OP },
    SRCBLENDALPHA: { id: 0x29, block: 'blend', names: BLEND },
    DESTBLENDALPHA: { id: 0x2a, block: 'blend', names: BLEND },
    BLENDOPALPHA: { id: 0x2b, block: 'blend', names: BLEND_OP },
    RENDERTARGETWRITEMASK: { id: 0x2c, block: 'blend', indexed: true },
    FILTER: { id: 0x2d, block: 'sampler', names: FILTER },
    ADDRESSU: { id: 0x2e, block: 'sampler', names: ADDRESS },
    ADDRESSV: { id: 0x2f, block: 'sampler', names: ADDRESS },
    ADDRESSW: { id: 0x30, block: 'sampler', names: ADDRESS },
    MIPLODBIAS: { id: 0x31, block: 'sampler' },
    MAXANISOTROPY: { id: 0x32, block: 'sampler' },
    COMPARISONFUNC: { id: 0x33, block: 'sampler', names: COMPARISON },
    BORDERCOLOR: { id: 0x34, block: 'sampler', count: 4 },
    MINLOD: { id: 0x35, block: 'sampler' },
    MAXLOD: { id: 0x36, block: 'sampler' },
    TEXTURE: { id: 0x37, block: 'sampler' },
};

/** The file name the scanner's positions carry: places in the preprocessed text. */
const EXPANDED = '<preprocessed>';

/** The name a constant standing in for an effect's own object starts with. */
const PLACEHOLDER = '__fx_object_';

/** The block each state object type has. */
const BLOCK_OF = /** @type {Record<string, string>} */ ({ BlendState: 'blend',
    DepthStencilState: 'depthstencil', RasterizerState: 'rasterizer', SamplerState: 'sampler',
    SamplerComparisonState: 'sampler' });

/** A failure in the effect's own syntax, at a token. */
class EffectError extends Error {
    /** @param {string} code @param {string} message @param {any} pos */
    constructor(code, message, pos){
        super(message);
        this.code = code;
        this.pos = pos;
    }
}

/**
 * @typedef {{ kind: 'number', value: number, float: boolean, unsigned: boolean, start: number,
 *       end: number }
 *   | { kind: 'name', name: string, index: Value | null, start: number, end: number }
 *   | { kind: 'call', name: string, args: Value[], plain: boolean, start: number, end: number,
 *       argsStart: number, argsEnd: number }
 *   | { kind: 'string', value: string, start: number, end: number }} Value
 * A value as an effect's own syntax writes it; `start` and `end` are token indices, the
 * arguments' text from argsStart to argsEnd.
 */

/**
 * @typedef {Object} Assignment
 * @property {number} state
 * @property {number} index
 * @property {number} kind
 * @property {{ type: number, bits: number }[]} [constants]
 * @property {string} [variable]
 * @property {number} [element]
 * @property {Uint8Array | null} [shader]   An anonymous shader's container.
 */

/**
 * @typedef {Object} EffectOptions
 * @property {string} profile
 * @property {number} [flags]
 * @property {number} [effectFlags]
 * @property {[string, string][]} [defines]
 * @property {import('../../win32/d3dx9/preprocess.js').PreprocessOptions['include']} [include]
 * @property {string} [source]
 */

/**
 * @param {string} source
 * @param {EffectOptions} options
 * @returns {Promise<import('./compile.js').Compile4Result>}
 */
export async function compileEffect(source, options){
    /** @type {string[]} */
    const messages = [];
    const failed = ()=>({ ok: false, bytes: null, messages: messages.map(m=>`${m}\n`)
        .join('') });
    const version = VERSIONS[options.profile];
    if (!version)
    {
        messages.push(`error X3506: '${options.profile}': invalid compiler target`);
        return failed();
    }
    const expanded = await preprocessTracked(source, { defines: options.defines,
        include: options.include });
    if ('error' in expanded)
    {
        messages.push(`${expanded.error.replace(/^([^:]*?)(\(\d+\))?: /, (_, file, line)=>
            `${file}${line ?? ''}: error X3000: `)}`);
        return failed();
    }
    /**
     * A position in the source: the scanner's are in the preprocessed text and are mapped back,
     * the front end's are the source's already, by the line markers.
     *
     * @param {any} pos
     */
    const where = pos=>{
        if (pos && pos.file !== EXPANDED)
        {
            return pos;
        }
        const origin = expanded.origins[(pos?.line ?? 1) - 1];
        return { file: origin?.file ?? 'memory', line: origin?.line ?? pos?.line ?? 1,
            col: pos?.col ?? 1 };
    };
    try
    {
        return await build(expanded.text, expanded.origins, version, options, messages);
    }
    catch (e){
        if (e instanceof EffectError)
        {
            messages.push(formatDiagnostic({ code: e.code, message: e.message,
                pos: where(e.pos) }));
            return failed();
        }
        if (e instanceof HlslError)
        {
            messages.push(formatDiagnostic({ code: e.code, message: e.message,
                pos: where(e.pos) }));
            return failed();
        }
        throw e;
    }
}

/**
 * The effect's declarations read out of the text, and the text without them.
 *
 * @param {string} text
 */
function scan(text){
    const { tokens } = tokenize(text, EXPANDED);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++)
    {
        if (text[i] === '\n')
        {
            lineStarts.push(i + 1);
        }
    }
    /** @param {number} t */
    const offset = t=>{
        const pos = tokens[t].pos;
        return (lineStarts[pos.line - 1] ?? text.length) + pos.col - 1;
    };
    const chars = text.split('');
    /** Blanks tokens from `from` to before `to`, the lines kept. @param {number} from @param {number} to */
    const blank = (from, to)=>{
        const end = to < tokens.length ? offset(to) : text.length;
        for (let i = offset(from); i < end; i++)
        {
            if (chars[i] !== '\n')
            {
                chars[i] = ' ';
            }
        }
    };
    /** @param {number} from @param {number} to */
    const slice = (from, to)=>text.slice(offset(from), to < tokens.length ? offset(to)
        : text.length);

    let at = 0;
    const peek = (/** @type {number} */ n = 0)=>tokens[at + n];
    const next = ()=>tokens[at++];
    /** @param {string} p */
    const isPunct = (p, n = 0)=>peek(n)?.type === 'punct' && peek(n).text === p;
    /** @param {string} p */
    const expect = p=>{
        if (!isPunct(p))
        {
            throw new EffectError('X3000', `syntax error: unexpected token '${peek()?.text
                ?? 'end of file'}', expected '${p}'`, peek()?.pos);
        }
        return next();
    };
    const ident = ()=>{
        if (peek()?.type !== 'ident')
        {
            throw new EffectError('X3000', `syntax error: unexpected token '${peek()?.text}'`,
                peek()?.pos);
        }
        return next();
    };

    /** A value: a number, a name (with an index), a call, a string. @returns {Value} */
    const value = ()=>{
        const start = at;
        let sign = 1;
        if (isPunct('-'))
        {
            next();
            sign = -1;
        }
        const token = peek();
        if (token.type === 'int' || token.type === 'float')
        {
            next();
            // fxc stores a hexadecimal or `u` literal as unsigned, any other as int.
            return { kind: 'number', value: sign * token.value, float: token.type === 'float',
                unsigned: token.type !== 'float' && /^0x|u$/i.test(token.text), start, end: at };
        }
        if (token.type === 'string')
        {
            next();
            return { kind: 'string', value: token.text, start, end: at };
        }
        const name = ident().text;
        if (isPunct('('))
        {
            next();
            const argsStart = at;
            /** @type {Value[]} */
            const args = [];
            let depth = 0;
            // The arguments of a shader's entry are HLSL: kept as text, read as values only
            // where they are this syntax's.
            const scanStart = at;
            while (!(depth === 0 && isPunct(')')))
            {
                if (peek().type === 'eof')
                {
                    throw new EffectError('X3000', 'syntax error: unexpected end of file',
                        peek().pos);
                }
                if (isPunct('('))
                {
                    depth++;
                }
                if (isPunct(')'))
                {
                    depth--;
                }
                next();
            }
            const argsEnd = at;
            at = scanStart;
            if (!isPunct(')'))
            {
                for (;;)
                {
                    const before = at;
                    try
                    {
                        args.push(value());
                    }
                    catch {
                        at = before;
                        break;
                    }
                    if (!isPunct(','))
                    {
                        break;
                    }
                    next();
                }
            }
            // Arguments that are not all this syntax's values are an expression: HLSL for a
            // shader's entry, an index or a value computed when the effect runs for a pass.
            const plain = at === argsEnd;
            if (!plain)
            {
                args.length = 0;
            }
            at = argsEnd;
            expect(')');
            return { kind: 'call', name, args, plain, start, end: at, argsStart, argsEnd };
        }
        /** @type {Value | null} */
        let index = null;
        if (isPunct('['))
        {
            next();
            index = value();
            expect(']');
        }
        return { kind: 'name', name: sign < 0 ? `-${name}` : name, index, start, end: at };
    };

    /** `< type name = value; ... >`, kept as text for the front end. */
    const annotationsText = ()=>{
        if (!isPunct('<'))
        {
            return '';
        }
        const start = at;
        while (!isPunct('>'))
        {
            if (peek().type === 'eof')
            {
                throw new EffectError('X3000', 'syntax error: unexpected end of file', peek().pos);
            }
            next();
        }
        next();
        return slice(start, at);
    };

    /** `{ Field[i] = value; ... }` of a state block. */
    const block = ()=>{
        /** @type {{ field: string, index: Value | null, value: Value, pos: any }[]} */
        const entries = [];
        expect('{');
        while (!isPunct('}'))
        {
            const name = ident();
            /** @type {Value | null} */
            let index = null;
            if (isPunct('['))
            {
                next();
                index = value();
                expect(']');
            }
            expect('=');
            const v = isPunct('<') ? (()=>{
                next();
                const inner = value();
                expect('>');
                return inner;
            })() : value();
            expect(';');
            entries.push({ field: name.text, index, value: v, pos: name.pos });
        }
        next();
        return entries;
    };

    /**
     * @typedef {{ type: string, name: string, dims: string, semantic: string,
     *     register: string, annotations: string,
     *     elements: { entries?: ReturnType<typeof block>, value?: Value }[], pos: any }} ObjectDecl
     */
    /** @type {ObjectDecl[]} */
    const objects = [];
    /** @type {{ name: string | null, annotations: string, pos: any,
     *     passes: { name: string | null, annotations: string, pos: any,
     *     calls: { name: string, args: Value[], raw: boolean, index: Value | null,
     *         pos: any }[] }[] }[]} */
    const techniques = [];
    /** Declarations to put back where a state block was: `SamplerState s;`. */
    /** @type {{ at: number, text: string }[]} */
    const keep = [];

    let depth = 0;
    while (peek().type !== 'eof')
    {
        const token = peek();
        if (token.type === 'punct')
        {
            if (token.text === '{' || token.text === '(')
            {
                depth++;
            }
            else if (token.text === '}' || token.text === ')')
            {
                depth--;
            }
            next();
            continue;
        }
        if (depth !== 0 || token.type !== 'ident')
        {
            next();
            continue;
        }
        const word = token.text;
        const lower = word.toLowerCase();
        if (lower === 'fxgroup' || lower === 'technique11')
        {
            throw new EffectError('X3000', `'${word}' is fx_5_0's, which is not compiled here`,
                token.pos);
        }
        if (word === 'shared')
        {
            throw new EffectError('X3000', '\'shared\': a variable an effect pool shares with its '
                + 'children is not compiled here', token.pos);
        }
        if (lower === 'technique10' || lower === 'technique')
        {
            const start = at;
            next();
            const name = peek().type === 'ident' ? next().text : null;
            const annotations = annotationsText();
            expect('{');
            /** @type {(typeof techniques)[number]['passes']} */
            const passes = [];
            while (!isPunct('}'))
            {
                const pass = ident();
                if (pass.text.toLowerCase() !== 'pass')
                {
                    throw new EffectError('X3000', `syntax error: unexpected token '${pass.text}'`,
                        pass.pos);
                }
                const passName = peek().type === 'ident' ? next().text : null;
                const passAnnotations = annotationsText();
                expect('{');
                /** @type {(typeof passes)[number]['calls']} */
                const calls = [];
                while (!isPunct('}'))
                {
                    const callee = ident();
                    if (isPunct('('))
                    {
                        at--;
                        const call = value();
                        expect(';');
                        calls.push({ name: callee.text, args: call.kind === 'call' ? call.args
                            : [], raw: call.kind === 'call' && !call.plain, index: null,
                        pos: callee.pos });
                        continue;
                    }
                    // The Direct3D 9 way, which fx_4_0 takes too: `VertexShader = ...;`.
                    /** @type {Value | null} */
                    let index = null;
                    if (isPunct('['))
                    {
                        next();
                        index = value();
                        expect(']');
                    }
                    expect('=');
                    const v = value();
                    expect(';');
                    calls.push({ name: callee.text, args: [v], raw: false, index,
                        pos: callee.pos });
                }
                next();
                passes.push({ name: passName, annotations: passAnnotations, pos: pass.pos,
                    calls });
            }
            next();
            if (isPunct(';'))
            {
                next();
            }
            techniques.push({ name, annotations, pos: token.pos, passes });
            blank(start, at);
            continue;
        }
        if (Object.hasOwn(OBJECT_KIND, word) && word !== 'String' && !/^Texture|^Buffer|^texture/
            .test(word))
        {
            const isSampler = word === 'SamplerState' || word === 'SamplerComparisonState';
            // A sampler without a block is HLSL as it stands.
            const start = at;
            next();
            const named = peek();
            if (named.type !== 'ident')
            {
                at = start + 1;
                continue;
            }
            next();
            let dims = '';
            while (isPunct('['))
            {
                const from = at;
                while (!isPunct(']'))
                {
                    next();
                }
                next();
                dims += slice(from, at);
            }
            let semantic = '';
            let register = '';
            while (isPunct(':'))
            {
                const from = at;
                next();
                ident();
                if (isPunct('('))
                {
                    while (!isPunct(')'))
                    {
                        next();
                    }
                    next();
                    register = slice(from, at);
                }
                else
                {
                    semantic = slice(from, at);
                }
            }
            const annotations = annotationsText();
            const kindOfBlock = BLOCK_OF[word];
            if (isSampler && !isPunct('{') && !isPunct('='))
            {
                continue;
            }
            /** @type {ObjectDecl['elements']} */
            const elements = [];
            if (isPunct('='))
            {
                next();
                if (isPunct('{'))
                {
                    // `= { {...}, {...} }`, an array of blocks, or `= { CompileShader(...),
                    // ... }`, an array of shaders.
                    next();
                    while (!isPunct('}'))
                    {
                        elements.push(isPunct('{') ? { entries: block() } : { value: value() });
                        if (isPunct(','))
                        {
                            next();
                        }
                    }
                    next();
                }
                else
                {
                    elements.push({ value: value() });
                }
            }
            else if (isPunct('{') && isPunct('{', 1))
            {
                // `BlendState b[2] { {...}, {...} };`: an array's blocks without the `=`.
                next();
                while (!isPunct('}'))
                {
                    elements.push({ entries: block() });
                    if (isPunct(','))
                    {
                        next();
                    }
                }
                next();
            }
            else if (isPunct('{'))
            {
                elements.push(kindOfBlock ? { entries: block() } : {});
            }
            expect(';');
            objects.push({ type: word, name: named.text, dims, semantic, register, annotations,
                elements, pos: named.pos });
            blank(start, at);
            // What stands in the object's place keeps its order among the variables: the
            // sampler itself, which the shaders use, or a constant the effect is read by.
            keep.push({ at: offset(start), text: isSampler
                ? `${word} ${named.text}${dims}${register};`
                : `static const int ${PLACEHOLDER}${objects.length - 1} = 0;` });
            continue;
        }
        next();
    }
    let stripped = chars.join('');
    for (const { at: where, text: decl } of keep.reverse())
    {
        stripped = `${stripped.slice(0, where)}${decl}${stripped.slice(where)}`;
    }
    return { objects, techniques, stripped, slice: (/** @type {number} */ from,
        /** @type {number} */ to)=>slice(from, to) };
}

/**
 * The effect: the declarations read, the rest checked, the shaders compiled, the file laid
 * out.
 *
 * @param {string} text @param {import('../../win32/d3dx9/preprocess.js').Origin[]} origins
 * @param {number} version @param {EffectOptions} options @param {string[]} messages
 * @returns {Promise<import('./compile.js').Compile4Result>}
 */
async function build(text, origins, version, options, messages){
    const scanned = scan(text);
    const hlsl = withLineMarkers(scanned.stripped, origins);
    const program = parse(hlsl, options.source);
    const rowMajor = ((options.flags ?? 0) & (1 << 3)) !== 0;
    const { module, diagnostics } = check(program, { rowMajor, sm4: true, bodies: false });
    for (const d of diagnostics)
    {
        messages.push(formatDiagnostic(d));
    }
    const failed = ()=>({ ok: false, bytes: null, messages: messages.map(m=>`${m}\n`)
        .join('') });
    if (diagnostics.some(d=>d.severity === 'error'))
    {
        return failed();
    }
    const fxProfile = options.profile;

    // ---- shaders --------------------------------------------------------------------------
    /** @type {Map<string, Uint8Array | null>} */
    const compiled = new Map();
    let compileFailed = false;
    /**
     * A shader a CompileShader names, compiled once for its profile, entry and arguments.
     * @param {Value} v @returns {Promise<Uint8Array | null>}
     */
    const shaderOf = async v=>{
        if (v.kind === 'call' && v.name === 'ConstructGSWithSO')
        {
            throw new EffectError('X3000', 'a geometry shader with stream output is not '
                + 'compiled here', null);
        }
        if (v.kind !== 'call' || v.name !== 'CompileShader' || v.args.length < 2)
        {
            throw new EffectError('X3000', 'a shader is CompileShader(profile, entry(...)), '
                + 'NULL or a shader variable', null);
        }
        const [profileArg, entryArg] = v.args;
        if (profileArg.kind !== 'name' || entryArg.kind !== 'call')
        {
            throw new EffectError('X3000', 'CompileShader takes a profile and a call of the '
                + 'entry point', null);
        }
        const argsText = scanned.slice(entryArg.argsStart, entryArg.argsEnd);
        const key = `${profileArg.name}/${entryArg.name}/${argsText}`;
        if (compiled.has(key))
        {
            return compiled.get(key) ?? null;
        }
        /** @type {any[]} */
        let args = [];
        if (argsText.trim() !== '')
        {
            const holder = parse(`void __fx_args() { __fx_call(${argsText}); }`);
            const fn = /** @type {any} */ (holder.decls[0]);
            args = fn.body.stmts[0].expr.args;
        }
        const result = await compileShader4(hlsl, { profile: profileArg.name,
            entry: entryArg.name, flags: options.flags, arguments: args, source: options.source });
        if (result.messages)
        {
            messages.push(...result.messages.trimEnd().split('\n'));
        }
        if (!result.ok)
        {
            compileFailed = true;
        }
        compiled.set(key, result.bytes);
        return result.bytes;
    };

    // ---- the variables -------------------------------------------------------------------
    const symbols = new Map(module.globals.map(g=>[g.name, g]));
    /** The cbuffer each declared member is in. */
    const byDecl = new Map(module.globals.map(g=>[g.decl, g]));

    /**
     * @typedef {{ name: string, type: Type, rowMajor: boolean, offset: number,
     *     semantic: string | null, flags: number, defaults: number[] | null,
     *     annotations: any[] }} NumericVariable
     * @typedef {{ name: string, size: number, tbuffer: boolean, annotations: any[],
     *     bindPoint: number,
     *     variables: NumericVariable[] }} Buffer
     */
    /** @type {Buffer[]} */
    const buffers = [{ name: '$Globals', size: 0, tbuffer: false, annotations: [],
        bindPoint: 0xffffffff,
        variables: [] }];
    const align16 = (/** @type {number} */ n)=>Math.ceil(n / 16) * 16;
    /** @param {Buffer} buffer @param {any} sym @param {{ at: number }} cursor */
    const addNumeric = (buffer, sym, cursor)=>{
        const symRowMajor = sym.rowMajor ?? module.rowMajor;
        const { size } = layoutOf(sym.type, symRowMajor);
        const pack = sym.decl.packoffset;
        let at;
        if (pack)
        {
            const register = Number(/^c(\d+)$/i.exec(pack.register)?.[1] ?? 0);
            at = register * 16 + 'xyzw'.indexOf((pack.component || 'x').toLowerCase()) * 4;
        }
        else
        {
            const t = sym.type;
            at = (t.kind === 'scalar' || t.kind === 'vector')
                && (cursor.at % 16) + size <= 16 ? cursor.at : align16(cursor.at);
        }
        cursor.at = Math.max(cursor.at, at + size);
        const initial = sym.init ? module.evaluateConstant(sym.init) : undefined;
        buffer.variables.push({ name: sym.name, type: sym.type, rowMajor: symRowMajor,
            offset: at, semantic: sym.semantic, flags: pack ? 4 : 0,
            defaults: initial === undefined ? null : packed(sym.type, initial, symRowMajor),
            annotations: sym.decl.annotations ?? [] });
        buffer.size = align16(cursor.at);
    };
    /** @param {Type} t */
    const isData = t=>{
        let inner = t;
        while (inner.kind === 'array')
        {
            inner = inner.elem;
        }
        return inner.kind === 'scalar' || inner.kind === 'vector' || inner.kind === 'matrix'
            || inner.kind === 'struct';
    };
    /**
     * @typedef {{ name: string, typeName: string, kind: number, elements: number,
     *     semantic: string | null, bindPoint: number, annotations: any[],
     *     data: { string?: string, shader?: Uint8Array | null,
     *         assignments?: Assignment[] }[] }} ObjectVariable
     */
    /** @type {ObjectVariable[]} */
    const objects = [];
    const globalsCursor = { at: 0 };
    /** @type {(t: Type) => number} */
    const elementsOf = t=>(t.kind === 'array' ? t.length * Math.max(1, elementsOf(t.elem)) : 0);
    for (const decl of program.decls)
    {
        if (decl.kind === 'cbuffer')
        {
            /** @type {Buffer} */
            const buffer = { name: decl.name, size: 0, tbuffer: decl.tbuffer,
                annotations: decl.annotations,
                bindPoint: decl.register && /^b\d+$/i.test(decl.register.name)
                    ? Number(decl.register.name.slice(1)) : 0xffffffff, variables: [] };
            const cursor = { at: 0 };
            for (const member of decl.members)
            {
                const sym = byDecl.get(member);
                if (sym && isData(sym.type))
                {
                    addNumeric(buffer, sym, cursor);
                }
                else if (sym)
                {
                    objects.push(objectOf(sym));
                }
            }
            buffers.push(buffer);
            continue;
        }
        if (decl.kind !== 'var')
        {
            continue;
        }
        if (decl.name.startsWith(PLACEHOLDER))
        {
            objects.push(await ownObject(scanned.objects[Number(decl.name.slice(
                PLACEHOLDER.length))]));
            continue;
        }
        const own = scanned.objects.find(o=>o.name === decl.name);
        if (own)
        {
            objects.push(await ownObject(own));
            continue;
        }
        const sym = byDecl.get(decl);
        if (!sym || sym.isStatic)
        {
            continue;
        }
        if (isData(sym.type))
        {
            addNumeric(buffers[0], sym, globalsCursor);
        }
        else
        {
            objects.push(objectOf(sym));
        }
    }

    /** @param {any} sym @returns {ObjectVariable} */
    function objectOf(sym){
        let inner = sym.type;
        while (inner.kind === 'array')
        {
            inner = inner.elem;
        }
        const elements = elementsOf(sym.type);
        let typeName;
        if (inner.kind === 'texture')
        {
            typeName = TEXTURE_NAME[inner.dim] ?? 'texture';
        }
        else if (inner.kind === 'sampler')
        {
            typeName = inner.dim === 'comparison' ? 'SamplerComparisonState' : 'SamplerState';
        }
        else if (inner.kind === 'string')
        {
            typeName = 'String';
        }
        else
        {
            throw new EffectError('X3000', `'${sym.name}': a ${inner.kind} cannot be a variable `
                + 'of an effect', sym.decl.pos);
        }
        /** @type {ObjectVariable['data']} */
        const data = Array.from({ length: Math.max(1, elements) }, ()=>({}));
        if (typeName === 'string')
        {
            const value = sym.init ? module.evaluateConstant(sym.init) : undefined;
            const values = Array.isArray(value) ? value : [value];
            data.forEach((one, i)=>{
                one.string = typeof values[i] === 'string' ? values[i] : '';
            });
        }
        if (typeName.startsWith('Sampler'))
        {
            data.forEach(one=>{
                one.assignments = [];
            });
        }
        return { name: sym.name, typeName, kind: OBJECT_KIND[typeName], elements,
            semantic: sym.semantic, bindPoint: 0xffffffff,
            annotations: sym.decl.annotations ?? [], data };
    }

    /**
     * An object the effect's own syntax declares: a state object, a shader variable, a
     * sampler with its block.
     *
     * @param {ReturnType<typeof scan>['objects'][number]} decl
     * @returns {Promise<ObjectVariable>}
     */
    async function ownObject(decl){
        const kind = OBJECT_KIND[decl.type];
        const elements = decl.dims ? Number(/\[\s*(\d+)\s*\]/.exec(decl.dims)?.[1] ?? 0) : 0;
        const annotations = decl.annotations
            ? /** @type {any} */ (parse(`float __fx ${decl.annotations};`).decls[0]).annotations
            : [];
        /** @type {ObjectVariable['data']} */
        const data = [];
        for (let i = 0; i < Math.max(1, elements); i++)
        {
            const element = decl.elements[i] ?? decl.elements[0] ?? {};
            if (BLOCK_OF[decl.type])
            {
                data.push({ assignments: blockAssignments(BLOCK_OF[decl.type],
                    element.entries ?? [], fxProfile, symbols) });
            }
            else if (kind === 5 || kind === 6 || kind === 7)
            {
                const v = element.value;
                data.push({ shader: !v || (v.kind === 'name' && /^(NULL|0)$/i.test(v.name))
                    || (v.kind === 'number' && v.value === 0) ? null : await shaderOf(v) });
            }
            else
            {
                data.push({});
            }
        }
        /** @type {ObjectVariable} */
        const variable = { name: decl.name, typeName: decl.type, kind, elements,
            semantic: decl.semantic ? decl.semantic.replace(/^\s*:\s*/, '') : null,
            bindPoint: 0xffffffff, annotations, data };
        return variable;
    }

    // ---- techniques -----------------------------------------------------------------------
    /** @type {{ name: string, annotations: any[], passes: { name: string, annotations: any[],
     *     assignments: Assignment[] }[] }[]} */
    const techniques = [];
    for (const technique of scanned.techniques)
    {
        const passes = [];
        for (const pass of technique.passes)
        {
            passes.push({ name: pass.name ?? '', annotations: annotationsOf(pass.annotations),
                assignments: await passAssignments(pass.calls, shaderOf, symbols) });
        }
        techniques.push({ name: technique.name ?? '',
            annotations: annotationsOf(technique.annotations), passes });
    }
    if (compileFailed)
    {
        return failed();
    }

    const bytes = writeEffect({ version, buffers, objects, techniques, module });
    return { ok: true, bytes, messages: messages.map(m=>`${m}\n`).join('') };

    /** @param {string} textOf */
    function annotationsOf(textOf){
        if (!textOf)
        {
            return [];
        }
        return /** @type {any} */ (parse(`float __fx ${textOf};`).decls[0]).annotations;
    }
}

/**
 * A pass's calls as assignments: SetVertexShader and its kin, SetBlendState with its factor
 * and mask, SetDepthStencilState with its reference, SetRasterizerState, or the Direct3D 9
 * way of writing one (`VertexShader = ...`).
 *
 * @param {{ name: string, args: Value[], raw: boolean, index: Value | null, pos: any }[]} calls
 * @param {(v: Value) => Promise<Uint8Array | null>} shaderOf
 * @param {Map<string, any>} symbols
 * @returns {Promise<Assignment[]>}
 */
async function passAssignments(calls, shaderOf, symbols){
    /** @type {Assignment[]} */
    const out = [];
    /** Where the call being read is, for its messages. @type {any} */
    let at = null;
    /** @param {number} state @param {Value | undefined} v */
    const objectState = (state, v)=>{
        if (!v || (v.kind === 'name' && /^NULL$/i.test(v.name))
            || (v.kind === 'number' && v.value === 0))
        {
            out.push({ state, index: 0, kind: ASSIGN.CONSTANT, constants: [{ type: CONSTANT.INT,
                bits: 0 }] });
            return;
        }
        if (v.kind !== 'name')
        {
            throw new EffectError('X3000', 'a pass names a state object, or NULL', at);
        }
        const element = v.index;
        if (element && element.kind !== 'number')
        {
            throw new EffectError('X3000', 'a state object picked by an index not known is not '
                + 'compiled here', at);
        }
        out.push(element ? { state, index: 0, kind: ASSIGN.CONSTANT_INDEX, variable: v.name,
            element: element.value } : { state, index: 0, kind: ASSIGN.VARIABLE,
            variable: v.name });
    };
    /** @param {number} state @param {Value | undefined} v */
    const shaderState = async(state, v)=>{
        if (!v || (v.kind === 'name' && /^NULL$/i.test(v.name))
            || (v.kind === 'number' && v.value === 0))
        {
            out.push({ state, index: 0, kind: ASSIGN.CONSTANT, constants: [{ type: CONSTANT.INT,
                bits: 0 }] });
            return;
        }
        if (v.kind === 'call')
        {
            out.push({ state, index: 0, kind: ASSIGN.ANONYMOUS_SHADER,
                shader: await shaderOf(v) });
            return;
        }
        objectState(state, v);
    };
    /** @param {number} state @param {Value | undefined} v @param {number} count */
    const constantState = (state, v, count)=>{
        if (!v)
        {
            return;
        }
        if (v.kind === 'name' && !/^(TRUE|FALSE)$/i.test(v.name))
        {
            out.push(variableAssignment(state, 0, v, symbols, count, at));
            return;
        }
        out.push({ state, index: 0, kind: ASSIGN.CONSTANT, constants: constantsOf(v, count,
            undefined, at) });
    };
    for (const call of calls)
    {
        if (call.args.length === 0 && call.raw)
        {
            throw new EffectError('X3000', `'${call.name}': a state computed by an expression `
                + 'needs the effect\'s expression code, which is not written here', call.pos);
        }
        at = call.pos;
        const [a, b, c] = call.args;
        switch (call.name.toLowerCase())
        {
            case 'setvertexshader':
            case 'vertexshader': await shaderState(PASS.VERTEX_SHADER, a); break;
            case 'setpixelshader':
            case 'pixelshader': await shaderState(PASS.PIXEL_SHADER, a); break;
            case 'setgeometryshader':
            case 'geometryshader': await shaderState(PASS.GEOMETRY_SHADER, a); break;
            case 'setblendstate':
            case 'blendstate':
                // fxc writes a call's values before its object.
                constantState(PASS.BLEND_FACTOR, b, 4);
                constantState(PASS.SAMPLE_MASK, c, 1);
                objectState(PASS.BLEND, a);
                break;
            case 'setdepthstencilstate':
            case 'depthstencilstate':
                constantState(PASS.STENCIL_REF, b, 1);
                objectState(PASS.DEPTH_STENCIL, a);
                break;
            case 'setrasterizerstate':
            case 'rasterizerstate': objectState(PASS.RASTERIZER, a); break;
            default:
                throw new EffectError('X3000', `'${call.name}' is not a state a pass sets`,
                    call.pos);
        }
    }
    return out;
}

/**
 * A state taken from a variable, or from an element of one a literal index picks. An index
 * computed when the effect runs, or a numeric variable with another count of values than the
 * state takes (fxc converts those with the effect's expression code), is refused: that code
 * is not written here.
 *
 * The element of a numeric array is counted in dwords of its constant buffer, an element a
 * register or more apart, as fxc writes it; an object's is its index.
 *
 * @param {number} state @param {number} index
 * @param {Extract<Value, { kind: 'name' }>} v
 * @param {Map<string, any>} symbols @param {number} count @param {any} pos
 * @returns {Assignment}
 */
function variableAssignment(state, index, v, symbols, count, pos){
    if (v.index && v.index.kind !== 'number')
    {
        throw new EffectError('X3000', `'${v.name}[...]': a variable picked by an index computed `
            + 'when the effect runs is not compiled here', pos);
    }
    const sym = symbols.get(v.name);
    /** @type {Type | undefined} */
    const type = sym?.type;
    const one = type?.kind === 'array' && v.index ? type.elem : type;
    let element = v.index?.value ?? 0;
    if (one && (one.kind === 'scalar' || one.kind === 'vector' || one.kind === 'matrix'))
    {
        if (scalarCount(one) !== count)
        {
            throw new EffectError('X3000', `'${v.name}': ${scalarCount(one)} values for a state `
                + `that takes ${count}; fxc converts them with the effect's expression code, `
                + 'which is not written here', pos);
        }
        element *= Math.ceil(layoutOf(one, false).size / 16) * 4;
    }
    return v.index ? { state, index, kind: ASSIGN.CONSTANT_INDEX, variable: v.name, element }
        : { state, index, kind: ASSIGN.VARIABLE, variable: v.name };
}

/**
 * The constants a value gives, as many as a state takes: numbers as they were written,
 * names of the field's enumeration as unsigned integers, TRUE and FALSE as bools.
 *
 * @param {Value} v @param {number} count @param {Record<string, number> | undefined} names
 * @param {any} pos
 * @returns {{ type: number, bits: number }[]}
 */
function constantsOf(v, count, names, pos){
    /** @param {Value} one @returns {{ type: number, bits: number }} */
    const scalar = one=>{
        if (one.kind === 'number')
        {
            return { type: one.float ? CONSTANT.FLOAT : one.unsigned ? CONSTANT.UINT
                : CONSTANT.INT, bits: one.float ? floatBits(one.value) : one.value >>> 0 };
        }
        if (one.kind === 'name')
        {
            const upper = one.name.toUpperCase();
            if (upper === 'TRUE' || upper === 'FALSE')
            {
                return { type: CONSTANT.BOOL, bits: upper === 'TRUE' ? 1 : 0 };
            }
            if (names && Object.hasOwn(names, upper))
            {
                return { type: CONSTANT.INT, bits: names[upper] >>> 0 };
            }
        }
        throw new EffectError('X3000', `'${one.kind === 'name' ? one.name : one.kind}' is not `
            + 'a value this state takes', pos);
    };
    if (v.kind === 'call' && /^(float|int|uint|bool)[1-4]?$/.test(v.name))
    {
        const values = v.args.map(scalar);
        while (values.length < count)
        {
            values.push(values.at(-1) ?? { type: CONSTANT.FLOAT, bits: 0 });
        }
        return values.slice(0, Math.max(count, 1));
    }
    const one = scalar(v);
    return new Array(Math.max(count, 1)).fill(one);
}

/**
 * A state block's entries as assignments, each to its field's id.
 *
 * @param {string} kind @param {{ field: string, index: Value | null, value: Value,
 *     pos: any }[]} entries
 * @param {string} profile @param {Map<string, any>} symbols
 * @returns {Assignment[]}
 */
function blockAssignments(kind, entries, profile, symbols){
    /** @type {Assignment[]} */
    const out = [];
    for (const entry of entries)
    {
        const field = FIELDS[entry.field.toUpperCase()];
        if (!field || field.block !== kind)
        {
            throw new EffectError('X3000', `'${entry.field}' is not a ${kind} state`, entry.pos);
        }
        // Direct3D 10.1 blends each render target its own way: fx_4_1 takes an index on every
        // blend field but alpha to coverage, and gives a field of 10.1's without one to all
        // eight targets; fx_4_0 takes one on the two fields 10.0 has per target.
        const perTarget = field.indexed || (profile === 'fx_4_1' && field.block === 'blend'
            && field.id !== FIELDS.ALPHATOCOVERAGEENABLE.id);
        let indices = [0];
        if (entry.index)
        {
            if (!perTarget)
            {
                throw new EffectError('X3000', `'${entry.field}[]': ${field.block === 'blend'
                    ? `per render target ${entry.field} is fx_4_1's, ${profile} has one`
                    : `${entry.field} takes no index`}`, entry.pos);
            }
            if (entry.index.kind !== 'number')
            {
                throw new EffectError('X3000', 'a state index must be a literal', entry.pos);
            }
            indices = [entry.index.value];
        }
        else if (perTarget && !field.indexed)
        {
            indices = [0, 1, 2, 3, 4, 5, 6, 7];
        }
        for (const index of indices)
        {
            // A field given again replaces what it was given, at the end of the list.
            const before = out.findIndex(a=>a.state === field.id && a.index === index);
            if (before >= 0)
            {
                out.splice(before, 1);
            }
            out.push(fieldAssignment(field, index, entry, symbols));
        }
    }
    return out;
}

/**
 * One field of a state block, at one index.
 *
 * @param {(typeof FIELDS)[string]} field @param {number} index
 * @param {{ field: string, value: Value, pos: any }} entry @param {Map<string, any>} symbols
 * @returns {Assignment}
 */
function fieldAssignment(field, index, entry, symbols){
    const v = entry.value;
    if (v.kind === 'name' && /^NULL$/i.test(v.name))
    {
        return { state: field.id, index, kind: ASSIGN.CONSTANT, constants: [{
            type: CONSTANT.INT, bits: 0 }] };
    }
    if (v.kind === 'name' && !(field.names && Object.hasOwn(field.names,
        v.name.toUpperCase())) && !/^(TRUE|FALSE)$/i.test(v.name))
    {
        if (!symbols.has(v.name))
        {
            throw new EffectError('X3004', `undeclared identifier '${v.name}'`, entry.pos);
        }
        return variableAssignment(field.id, index, v, symbols, field.count ?? 1, entry.pos);
    }
    return { state: field.id, index, kind: ASSIGN.CONSTANT,
        constants: constantsOf(v, field.count ?? 1, field.names, entry.pos) };
}

const scratch = new DataView(new ArrayBuffer(4));
/** @param {number} x */
function floatBits(x){
    scratch.setFloat32(0, x, true);
    return scratch.getUint32(0, true);
}

/**
 * A value's dwords packed as an effect stores defaults: no padding, a matrix register by
 * register (a column at a time, or a row for row_major).
 *
 * @param {Type} type @param {any} value @param {boolean} rowMajor
 * @returns {number[]}
 */
function packed(type, value, rowMajor){
    /** @param {number} x @param {string} base */
    const word = (x, base)=>(base === 'float' ? floatBits(x) : base === 'bool' ? (x ? 1 : 0)
        : x >>> 0);
    switch (type.kind)
    {
        case 'scalar': return [word(value, type.base)];
        case 'vector': return value.map((/** @type {number} */ x)=>word(x, type.base));
        case 'matrix': {
            /** @type {number[]} */
            const out = [];
            const outer = rowMajor ? type.rows : type.cols;
            const inner = rowMajor ? type.cols : type.rows;
            for (let a = 0; a < outer; a++)
            {
                for (let b = 0; b < inner; b++)
                {
                    out.push(word(rowMajor ? value[a][b] : value[b][a], type.base));
                }
            }
            return out;
        }
        case 'array': return value.flatMap((/** @type {any} */ v)=>packed(type.elem, v, rowMajor));
        case 'struct': return type.members.flatMap(m=>packed(m.type, value[m.name],
            m.rowMajor ?? rowMajor));
        default: return flattenValue(value, type).map(x=>x >>> 0);
    }
}

/** The name fxc gives a numeric type. @param {Type} t */
function numericTypeName(t){
    switch (t.kind)
    {
        case 'scalar': return t.base;
        case 'vector': return `${t.base}${t.n}`;
        case 'matrix': return `${t.base}${t.rows}x${t.cols}`;
        case 'struct': return t.name.startsWith('<') ? '' : t.name;
        case 'array': return numericTypeName(t.elem);
        default: return '';
    }
}

/**
 * The FX10 chunk, in a container.
 *
 * @param {{ version: number, buffers: any[], objects: any[], techniques: any[],
 *     module: any }} effect
 * @returns {Uint8Array}
 */
function writeEffect(effect){
    /** @type {number[]} */
    const block = [];
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** @param {number} value */
    const pushWord = value=>{
        const v = value >>> 0;
        block.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
    };
    /** @param {string} text */
    const stringAt = text=>{
        const known = strings.get(text);
        if (known !== undefined)
        {
            return known;
        }
        const at = block.length;
        for (const char of text)
        {
            block.push(char.charCodeAt(0) & 0xff);
        }
        block.push(0);
        strings.set(text, at);
        return at;
    };
    /** @param {number[]} words */
    const wordsAt = words=>{
        while (block.length % 4 !== 0)
        {
            block.push(0);
        }
        const at = block.length;
        words.forEach(pushWord);
        return at;
    };
    /** Types written, by what they are. @type {Map<string, number>} */
    const types = new Map();
    const BASE = /** @type {Record<string, number>} */ ({ float: 1, int: 2, uint: 3, bool: 4 });

    /**
     * A numeric or structure type's record.
     * @param {Type} type @param {boolean} rowMajor @returns {number}
     */
    const typeAt = (type, rowMajor)=>{
        const key = `${JSON.stringify(type)}/${rowMajor}`;
        const known = types.get(key);
        if (known !== undefined)
        {
            return known;
        }
        const elements = type.kind === 'array' ? type.length : 0;
        const inner = type.kind === 'array' ? type.elem : type;
        const { size } = layoutOf(type, rowMajor);
        const one = layoutOf(inner, rowMajor).size;
        const stride = Math.ceil(one / 16) * 16;
        const packedSize = scalarCount(type) * 4;
        /** @type {number[]} */
        let tail;
        let kind;
        if (inner.kind === 'struct')
        {
            const { rdef } = layoutOf(inner, rowMajor);
            const members = inner.members.map((m, i)=>[stringAt(m.name),
                m.semantic ? stringAt(m.semantic) : 0, rdef.members[i].offset,
                typeAt(m.type, m.rowMajor ?? rowMajor)]);
            kind = 3;
            tail = [members.length, ...members.flat()];
        }
        else
        {
            kind = 1;
            const base = BASE[/** @type {string} */ (baseOf(inner))] ?? 1;
            const rows = inner.kind === 'matrix' ? inner.rows : 1;
            const cols = inner.kind === 'matrix' ? inner.cols : inner.kind === 'vector'
                ? inner.n : 1;
            const layout = inner.kind === 'scalar' ? 1 : inner.kind === 'vector' ? 2 : 3;
            tail = [layout | (base << 3) | (rows << 8) | (cols << 11)
                | (inner.kind === 'matrix' && !rowMajor ? 0x4000 : 0)];
        }
        const name = stringAt(numericTypeName(inner));
        const at = wordsAt([name, kind, elements, size, stride, packedSize, ...tail]);
        types.set(key, at);
        return at;
    };
    /** @param {string} typeName @param {number} code @param {number} elements */
    const objectTypeAt = (typeName, code, elements)=>{
        const key = `object/${typeName}/${elements}`;
        const known = types.get(key);
        if (known !== undefined)
        {
            return known;
        }
        const name = stringAt(typeName);
        const at = wordsAt([name, 2, elements, 0, 0, 0, code]);
        types.set(key, at);
        return at;
    };
    /** @param {Uint8Array | null | undefined} bytes */
    const shaderAt = bytes=>{
        if (!bytes)
        {
            return 0;
        }
        const at = wordsAt([bytes.length]);
        block.push(...bytes);
        return at;
    };

    /** @type {number[]} */
    const structured = [];
    /** @param {number[]} words */
    const put = words=>structured.push(...words);
    /**
     * Annotations as the parser has them: a type, a name, a value.
     * @param {any[]} annotations
     */
    const putAnnotations = annotations=>{
        put([annotations.length]);
        for (const annotation of annotations)
        {
            put([stringAt(annotation.name)]);
            const literal = literalOf(annotation.value);
            let type = fromTypeRef(annotation.type, ()=>null, true);
            if (!type || (type.kind !== 'string' && type.kind !== 'scalar'
                && type.kind !== 'vector' && type.kind !== 'matrix'))
            {
                throw new EffectError('X3000', `annotation '${annotation.name}': a ${
                    annotation.type.cls} annotation is not compiled here`, annotation.pos);
            }
            if (annotation.value && !literal)
            {
                throw new EffectError('X3000', `annotation '${annotation.name}': its value must `
                    + 'be made of literals', annotation.pos);
            }
            if (type.kind === 'string')
            {
                const texts = literal?.strings ?? [];
                const count = annotation.dims.length > 0 ? Math.max(1, texts.length) : 0;
                put([objectTypeAt('String', 1, count)]);
                for (let i = 0; i < Math.max(1, count); i++)
                {
                    put([stringAt(texts[i] ?? '')]);
                }
                continue;
            }
            if (annotation.dims.length > 0)
            {
                const per = scalarCount(type);
                type = arrayOf(type, Math.max(1, Math.ceil((literal?.numbers.length ?? per)
                    / per)));
            }
            const bases = flatBases(type);
            const numbers = literal?.numbers ?? [];
            put([typeAt(type, false), wordsAt(bases.map((base, i)=>{
                const x = numbers[i] ?? 0;
                return base === 'float' ? floatBits(x) : base === 'bool' ? (x ? 1 : 0)
                    : Math.trunc(x) >>> 0;
            }))]);
        }
    };
    /** @param {Assignment[]} assignments */
    const putAssignments = assignments=>{
        for (const a of assignments)
        {
            let data = 0;
            if (a.kind === ASSIGN.CONSTANT)
            {
                const constants = a.constants ?? [];
                data = wordsAt([constants.length, ...constants.flatMap(c=>[c.type, c.bits])]);
            }
            else if (a.kind === ASSIGN.VARIABLE)
            {
                data = stringAt(a.variable ?? '');
            }
            else if (a.kind === ASSIGN.CONSTANT_INDEX)
            {
                data = wordsAt([stringAt(a.variable ?? ''), a.element ?? 0]);
            }
            else if (a.kind === ASSIGN.ANONYMOUS_SHADER)
            {
                data = wordsAt([shaderAt(a.shader), 0]);
            }
            put([a.state, a.index, a.kind, data]);
        }
    };

    // The first name of the block: a name at offset zero is a name, as fxc writes it.
    stringAt(effect.buffers[0].name);
    let numericVariables = 0;
    for (const buffer of effect.buffers)
    {
        put([stringAt(buffer.name), buffer.size, buffer.tbuffer ? 1 : 0,
            buffer.variables.length, buffer.bindPoint]);
        putAnnotations(buffer.annotations);
        for (const variable of buffer.variables)
        {
            numericVariables++;
            put([stringAt(variable.name), typeAt(variable.type, variable.rowMajor),
                variable.semantic ? stringAt(variable.semantic) : 0, variable.offset,
                variable.defaults ? wordsAt(variable.defaults) : 0, variable.flags]);
            putAnnotations(variable.annotations);
        }
    }
    /** Counts by object kind, for the header. */
    const counts = { strings: 0, textures: 0, depthStencil: 0, blend: 0, rasterizer: 0,
        samplers: 0, rtv: 0, dsv: 0, shaders: 0, inline: 0 };
    for (const object of effect.objects)
    {
        const n = Math.max(1, object.elements);
        put([stringAt(object.name), objectTypeAt(object.typeName, object.kind, object.elements),
            object.semantic ? stringAt(object.semantic) : 0, object.bindPoint]);
        for (let i = 0; i < n; i++)
        {
            const element = object.data[i] ?? {};
            switch (object.kind)
            {
                case 1:
                    counts.strings++;
                    put([stringAt(element.string ?? '')]);
                    break;
                case 5: case 6: case 7:
                    counts.shaders++;
                    put([shaderAt(element.shader)]);
                    break;
                case 2: case 3: case 4: case 21: {
                    counts[STATE_COUNT[object.kind]]++;
                    const assignments = element.assignments ?? [];
                    put([assignments.length]);
                    putAssignments(assignments);
                    break;
                }
                case 19: counts.rtv++; break;
                case 20: counts.dsv++; break;
                default: counts.textures++;
            }
        }
        putAnnotations(object.annotations);
    }
    for (const technique of effect.techniques)
    {
        put([stringAt(technique.name), technique.passes.length]);
        putAnnotations(technique.annotations);
        for (const pass of technique.passes)
        {
            put([stringAt(pass.name), pass.assignments.length]);
            putAnnotations(pass.annotations);
            for (const a of pass.assignments)
            {
                if (a.kind === ASSIGN.ANONYMOUS_SHADER)
                {
                    counts.shaders++;
                    counts.inline++;
                }
            }
            putAssignments(pass.assignments);
        }
    }
    while (block.length % 4 !== 0)
    {
        block.push(0);
    }
    const header = [effect.version, effect.buffers.length, numericVariables,
        effect.objects.length, 0, 0, 0, effect.techniques.length, block.length, counts.strings,
        counts.textures, counts.depthStencil, counts.blend, counts.rasterizer, counts.samplers,
        counts.rtv, counts.dsv, counts.shaders, counts.inline];
    const bytes = new Uint8Array(header.length * 4 + block.length + structured.length * 4);
    const view = new DataView(bytes.buffer);
    header.forEach((value, i)=>view.setUint32(i * 4, value >>> 0, true));
    bytes.set(block, header.length * 4);
    structured.forEach((value, i)=>view.setUint32(header.length * 4 + block.length + i * 4,
        value >>> 0, true));
    return writeContainer([{ name: 'FX10', bytes }]);
}
