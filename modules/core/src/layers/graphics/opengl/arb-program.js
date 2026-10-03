/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * ARB vertex and fragment program text, parsed into an IR.
 *
 * `glProgramStringARB` hands over the ASCII text a program was compiled from,
 * and GL_PROGRAM_ERROR_POSITION_ARB promises the byte offset of the first
 * offending character when it is refused -- so the parser reports positions
 * in bytes of the text it was given, and nothing downstream has to guess.
 *
 * The shape of the IR follows the two specifications' grammar rather than any
 * translator's convenience:
 *
 * - **Names are resolved here, once.** A source operand that names a `TEMP`
 *   arrives as a temporary; one that names a `PARAM` carries the name and,
 *   for an array, an absolute index or a relative offset; a binding written
 *   inline (`vertex.texcoord[1]`, `program.env[3]`, `state.matrix.mvp.row[0]`,
 *   `{ 1.0, 0.5 }`) is resolved to the same binding structures a declaration
 *   would hold. An emitter looks names up in the declaration lists and never
 *   re-parses anything.
 * - **Swizzles are normalised to four components.** A scalar suffix `.x`
 *   replicates, a missing suffix is identity, `rgba` letters become `xyzw`,
 *   and negation is a `-` on each component. The one exception is `SWZ`,
 *   whose extended components can also be the constants `0` and `1` with a
 *   sign of their own; an operand that came from one is marked `extended`.
 * - **Parameter arrays flatten to slots.** `PARAM c[4] = { state.matrix.mvp }`
 *   is four row bindings in one declaration, which is what a relative
 *   `c[a0.x + 2]` then indexes.
 * - **State bindings the GPU path has no uniform for are kept, not refused.**
 *   Everything under `state.` parses; the matrices arrive as full bindings and
 *   the rest are marked unsupported with the text as written, so a draw can
 *   diverge by name instead of a program failing to load that would have run
 *   on hardware which answered those bindings.
 *
 * Limits are enforced where the specification puts them: at load, against the
 * same maxima the context reports, so a program that loads is within native
 * limits by construction.
 */

/**
 * @typedef {Object} ProgramError
 * @property {number} position  byte offset of the first offending character
 * @property {string} message
 */

/**
 * @typedef {Object} VertexBinding
 *     One conventional or generic vertex attribute binding.
 * @property {'vertex'} kind
 * @property {'position' | 'weight' | 'normal' | 'color-primary' | 'color-secondary'
 *          | 'fogcoord' | 'texcoord' | 'matrixindex' | 'attrib'} name
 * @property {number} index  the texcoord set, the weight unit or the attrib number
 * @property {number | null} attrib  the generic attribute number the aliasing
 *           table gives, or null for a binding with none (an extra weight, a
 *           matrix index)
 */

/**
 * @typedef {Object} FragmentBinding
 * @property {'fragment'} kind
 * @property {'position' | 'color-primary' | 'color-secondary' | 'fogcoord' | 'texcoord'} name
 * @property {number} index  the texcoord set
 */

/**
 * @typedef {Object} ResultBinding
 * @property {'result'} kind
 * @property {'position' | 'color' | 'fogcoord' | 'pointsize' | 'texcoord' | 'depth'} name
 * @property {'front' | 'back' | null} face
 * @property {'primary' | 'secondary' | null} colour
 * @property {number} index  the texcoord set
 */

/**
 * @typedef {Object} ProgramParamBinding
 * @property {'local' | 'env'} kind
 * @property {number} index
 */

/**
 * @typedef {Object} ConstantBinding
 * @property {'constant'} kind
 * @property {readonly number[]} values  four floats
 */

/**
 * @typedef {Object} MatrixBinding
 *     One row of one state matrix, its modifier a name the draw path computes.
 * @property {'state'} kind
 * @property {'matrix'} state
 * @property {'modelview' | 'projection' | 'mvp' | 'texture'} matrix
 * @property {number} number  the modelview stack or texture unit
 * @property {'' | 'inverse' | 'transpose' | 'invtrans'} modifier
 * @property {number} row
 */

/**
 * @typedef {Object} UnsupportedBinding
 *     A state binding the grammar accepts and the GPU path has no uniform for.
 * @property {'state'} kind
 * @property {'material' | 'light' | 'lightmodel' | 'lightprod' | 'texgen' | 'fog' | 'clip'
 *          | 'point' | 'texenv' | 'depth' | 'palette' | 'program-matrix'} state
 * @property {string} text  the binding as written, for the divergence that names it
 */

/**
 * @typedef {MatrixBinding | UnsupportedBinding | ProgramParamBinding | ConstantBinding}
 *     ParamBinding
 */

/**
 * @typedef {VertexBinding | FragmentBinding | ResultBinding | ParamBinding} Binding
 */

/**
 * @typedef {Object} Operand
 * @property {'temp' | 'attrib' | 'param' | 'output' | 'address' | 'constant'} kind
 * @property {string | null} name  the declared name of a temp, param, attrib,
 *           output or address register
 * @property {Binding | null} binding  the binding written inline, of a named
 *           output, or of a constant; null behind any other declared name
 * @property {number | null} index  the absolute index of a parameter array use
 * @property {number | null} relative  the offset of a `[a0.x + n]` use
 * @property {readonly string[] | null} components  the four normalised source
 *           components, each `x`..`w`, `0` or `1`, with a leading `-` when
 *           negated; null on a destination
 * @property {string | null} mask  the destination write mask, normalised to
 *           ascending `xyzw` letters; null on a source
 * @property {boolean} saturate
 * @property {boolean} extended  a SWZ source, whose components can be signed
 *           constants
 */

/**
 * @typedef {Object} Instruction
 * @property {string} op  the opcode, `_SAT` stripped
 * @property {boolean} saturate  the `_SAT` suffix, fragment programs only
 * @property {Operand | null} dst
 * @property {Operand[]} src
 * @property {{ unit: number, target: '1D' | '2D' | '3D' | 'CUBE' | 'RECT' } | null} texture
 */

/**
 * @typedef {Object} ParamDecl
 * @property {string} name
 * @property {boolean} array
 * @property {readonly Binding[]} slots  one binding per parameter
 * @property {number} position
 */

/**
 * @typedef {Object} ProgramCounts
 * @property {number} instructions
 * @property {number} alu
 * @property {number} tex
 * @property {number} temporaries
 * @property {number} parameters
 * @property {number} attribs
 * @property {number} addressRegisters
 */

/**
 * @typedef {Object} ParsedProgram
 * @property {'vertex' | 'fragment'} kind
 * @property {readonly string[]} options
 * @property {boolean} positionInvariant
 * @property {'fastest' | 'nicest' | null} precisionHint
 * @property {'exp' | 'exp2' | 'linear' | null} fog
 * @property {readonly string[]} temporaries
 * @property {string | null} address  the one address register's name
 * @property {readonly { name: string, target: string }[]} aliases
 * @property {readonly ParamDecl[]} params
 * @property {readonly { name: string, binding: VertexBinding, position: number }[]} attribs
 * @property {readonly { name: string, binding: ResultBinding }[]} outputs
 * @property {readonly Instruction[]} instructions
 * @property {ProgramCounts} counts
 */

/**
 * @typedef {{ error: ProgramError } | ParsedProgram} ParseResult
 */

/** The generic attribute number each conventional binding arrives through. */
export const VERTEX_ATTRIB_OF = Object.freeze({
    position: 0,
    weight: 1,
    normal: 2,
    'color-primary': 3,
    'color-secondary': 4,
    fogcoord: 5,
    matrixindex: 6,
});

/** The generic attribute number each canonical array name arrives through. */
const CANONICAL_ATTRIB = Object.freeze({
    position: 0,
    normal: 2,
    color: 3,
    secondary: 4,
    fogCoord: 5,
    texCoord0: 8,
    texCoord1: 9,
    texCoord2: 10,
    texCoord3: 11,
    texCoord4: 12,
    texCoord5: 13,
    texCoord6: 14,
    texCoord7: 15,
});

/**
 * The canonical name a generic attribute number arrives through, where the
 * aliasing table gives one: attribute 0 is the position array, 8+n the
 * texture coordinate array of unit n, and the rest have names of their own
 * (`attribN`).
 *
 * @param {number} attrib
 * @returns {string}
 */
export function canonicalAttribName(attrib){
    return ATTRIB_NAMES[attrib] ?? nameOfAttrib(attrib);
}

/** @param {number} attrib */
function nameOfAttrib(attrib){
    for (const [name, number] of Object.entries(CANONICAL_ATTRIB))
    {
        if (number === attrib)
        {
            return name;
        }
    }
    return `attrib${attrib}`;
}

/** The names of the attributes a program can address, asked for on every draw. */
const ATTRIB_NAMES = Array.from({ length: 16 }, (_, attrib)=>nameOfAttrib(attrib));

/**
 * The limits this implementation reports and enforces, per program kind. The
 * specification's minima are the floor (vertex: 128 instructions, 12
 * temporaries, 96 parameters; fragment: 72 ALU and 24 TEX instructions, 16
 * temporaries, 24 parameters); these are above every minimum so that a real
 * program written against hardware of the era loads, while a program past
 * them is refused at glProgramStringARB as it would be on hardware.
 */
export const PROGRAM_LIMITS = Object.freeze({
    vertex: Object.freeze({
        instructions: 512,
        nativeInstructions: 512,
        temporaries: 32,
        nativeTemporaries: 32,
        parameters: 256,
        nativeParameters: 256,
        attribs: 16,
        nativeAttribs: 16,
        addressRegisters: 1,
        nativeAddressRegisters: 1,
        envParameters: 96,
        localParameters: 256,
    }),
    fragment: Object.freeze({
        instructions: 512,
        nativeInstructions: 512,
        aluInstructions: 512,
        nativeAluInstructions: 512,
        texInstructions: 512,
        nativeTexInstructions: 512,
        texIndirections: 8,
        nativeTexIndirections: 8,
        temporaries: 32,
        nativeTemporaries: 32,
        parameters: 256,
        nativeParameters: 256,
        attribs: 16,
        nativeAttribs: 16,
        envParameters: 96,
        localParameters: 256,
    }),
});

/**
 * The instruction tables: opcode -> the operand shape. `vector` and `scalar`
 * sources differ in the suffix they require; `swz` reads its source bare and
 * takes an extended swizzle; `tex` and `kil` are the fragment specials.
 *
 * @type {Readonly<Record<'vertex' | 'fragment', Readonly<Record<string, string>>>>}
 */
const OPCODES = Object.freeze({
    vertex: Object.freeze({
        ARL: 'addr',
        ABS: 'vector', FLR: 'vector', FRC: 'vector', LIT: 'vector', MOV: 'vector',
        EX2: 'scalar', EXP: 'scalar', LG2: 'scalar', LOG: 'scalar', RCP: 'scalar', RSQ: 'scalar',
        POW: 'binscalar',
        ADD: 'binary', DP3: 'binary', DP4: 'binary', DPH: 'binary', DST: 'binary',
        MAX: 'binary', MIN: 'binary', MUL: 'binary', SGE: 'binary', SLT: 'binary',
        SUB: 'binary', XPD: 'binary',
        MAD: 'ternary',
        SWZ: 'swz',
    }),
    fragment: Object.freeze({
        ABS: 'vector', FLR: 'vector', FRC: 'vector', LIT: 'vector', MOV: 'vector',
        COS: 'scalar', EX2: 'scalar', LG2: 'scalar', RCP: 'scalar', RSQ: 'scalar',
        SIN: 'scalar', SCS: 'scalar',
        POW: 'binscalar',
        ADD: 'binary', DP3: 'binary', DP4: 'binary', DPH: 'binary', DST: 'binary',
        MAX: 'binary', MIN: 'binary', MUL: 'binary', SGE: 'binary', SLT: 'binary',
        SUB: 'binary', XPD: 'binary',
        CMP: 'ternary', LRP: 'ternary', MAD: 'ternary',
        SWZ: 'swz',
        TEX: 'tex', TXB: 'tex', TXP: 'tex',
        KIL: 'kil',
    }),
});

/**
 * How many plain sources an operand shape reads.
 *
 * @param {string} shape
 */
const sourceCount = shape=>(shape === 'ternary' ? 3
    : shape === 'binary' || shape === 'binscalar' ? 2 : 1);

/** The names no identifier may use, as both specifications list them. */
const RESERVED = new Set([
    'ABS', 'ABS_SAT', 'ADD', 'ADD_SAT', 'ADDRESS', 'ALIAS', 'ARL', 'ATTRIB', 'CMP', 'CMP_SAT',
    'COS', 'COS_SAT', 'DP3', 'DP3_SAT', 'DP4', 'DP4_SAT', 'DPH', 'DPH_SAT', 'DST', 'DST_SAT',
    'END', 'EX2', 'EX2_SAT', 'EXP', 'FLR', 'FLR_SAT', 'FRC', 'FRC_SAT', 'KIL', 'LG2', 'LG2_SAT',
    'LIT', 'LIT_SAT', 'LOG', 'LRP', 'LRP_SAT', 'MAD', 'MAD_SAT', 'MAX', 'MAX_SAT', 'MIN',
    'MIN_SAT', 'MOV', 'MOV_SAT', 'MUL', 'MUL_SAT', 'OPTION', 'OUTPUT', 'PARAM', 'POW', 'POW_SAT',
    'RCP', 'RCP_SAT', 'RSQ', 'RSQ_SAT', 'SCS', 'SCS_SAT', 'SGE', 'SGE_SAT', 'SIN', 'SIN_SAT',
    'SLT', 'SLT_SAT', 'SUB', 'SUB_SAT', 'SWZ', 'SWZ_SAT', 'TEMP', 'TEX', 'TEX_SAT', 'TXB',
    'TXB_SAT', 'TXP', 'TXP_SAT', 'XPD', 'XPD_SAT',
    'fragment', 'program', 'result', 'state', 'texture', 'vertex',
]);

const XYZW = 'xyzw';
const RGBA = 'rgba';
const MASK_ORDER = ['', 'x', 'y', 'xy', 'z', 'xz', 'yz', 'xyz', 'w', 'xw', 'yw', 'xyw', 'zw',
    'xzw', 'yzw', 'xyzw'];
const MATRIX_MODIFIERS = ['inverse', 'transpose', 'invtrans'];
const FACE_TYPES = ['front', 'back'];

/** An internal refusal carrying the byte position the error string reports. */
class Refused extends Error {
    /** @param {number} position @param {string} message */
    constructor(position, message){
        super(message);
        this.position = position;
    }
}

/**
 * @typedef {Object} Token
 * @property {'header' | 'identifier' | 'int' | 'float' | 'symbol'} type
 * @property {string} value
 * @property {number} position
 */

/** @param {string} c */
const isDigit = c=>c >= '0' && c <= '9';
/** @param {string} c */
const isIdentStart = c=>(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
/** @param {string} c */
const isIdentChar = c=>isIdentStart(c) || isDigit(c);

/**
 * The token stream of a program text, or the lexing error.
 *
 * @param {string} text
 * @returns {{ tokens: Token[], error: null } | { tokens: null, error: ProgramError }}
 */
function lex(text){
    /** @type {Token[]} */
    const tokens = [];
    let at = 0;
    while (at < text.length)
    {
        const c = text[at];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\v' || c === '\f')
        {
            at++;
            continue;
        }
        if (c === '#')
        {
            while (at < text.length && text[at] !== '\n')
            {
                at++;
            }
            continue;
        }
        if (c === '!' && text.startsWith('!!', at))
        {
            const start = at;
            at += 2;
            while (at < text.length && (isIdentChar(text[at]) || text[at] === '.'))
            {
                at++;
            }
            tokens.push({ type: 'header', value: text.slice(start, at), position: start });
            continue;
        }
        if (isDigit(c) || (c === '.' && isDigit(text[at + 1] ?? '')))
        {
            const start = at;
            while (at < text.length && isDigit(text[at]))
            {
                at++;
            }
            let float = false;
            // A '.' only joins the number when a digit follows it, so the
            // range in `program.local[0..3]` stays two tokens either side.
            if (text[at] === '.' && isDigit(text[at + 1] ?? ''))
            {
                float = true;
                at++;
                while (at < text.length && isDigit(text[at]))
                {
                    at++;
                }
            }
            const e = text[at];
            if ((e === 'e' || e === 'E')
                && (isDigit(text[at + 1] ?? '')
                    || ((text[at + 1] === '+' || text[at + 1] === '-')
                        && isDigit(text[at + 2] ?? ''))))
            {
                float = true;
                at += 2;
                while (at < text.length && isDigit(text[at]))
                {
                    at++;
                }
            }
            // `1D` and `3D` are texture targets, not a number and a name.
            if (isIdentStart(text[at] ?? ''))
            {
                while (at < text.length && isIdentChar(text[at]))
                {
                    at++;
                }
                tokens.push({ type: 'identifier', value: text.slice(start, at), position: start });
                continue;
            }
            tokens.push({
                type: float ? 'float' : 'int', value: text.slice(start, at), position: start,
            });
            continue;
        }
        if (isIdentStart(c))
        {
            const start = at;
            while (at < text.length && isIdentChar(text[at]))
            {
                at++;
            }
            tokens.push({ type: 'identifier', value: text.slice(start, at), position: start });
            continue;
        }
        if (text.startsWith('..', at))
        {
            tokens.push({ type: 'symbol', value: '..', position: at });
            at += 2;
            continue;
        }
        if (';,={}[]()+-.'.includes(c))
        {
            tokens.push({ type: 'symbol', value: c, position: at });
            at++;
            continue;
        }
        return { tokens: null, error: { position: at, message: `unexpected character '${c}'` } };
    }
    return { tokens, error: null };
}

/**
 * Reads one program text.
 *
 * @param {string} text
 * @returns {ParseResult}
 */
export function parseProgram(text){
    const lexed = lex(text);
    if (lexed.error)
    {
        return { error: lexed.error };
    }
    try
    {
        return parse(/** @type {Token[]} */ (lexed.tokens), text);
    }
    catch (e){
        if (e instanceof Refused)
        {
            return { error: { position: e.position, message: e.message } };
        }
        throw e;
    }
}

/**
 * The recursive-descent half. Everything that can refuse a program throws
 * `Refused` with the position of the character that offended.
 *
 * @param {Token[]} tokens
 * @param {string} text
 * @returns {ParsedProgram}
 */
function parse(tokens, text){
    let at = 0;

    /** @param {string} message @param {number} [position] @returns {never} */
    const fail = (message, position)=>{
        throw new Refused(position ?? (tokens[at]?.position ?? text.length), message);
    };

    const peek = ()=>tokens[at] ?? null;
    /** @param {string} value */
    const peekSymbol = value=>{
        const token = peek();
        return token !== null && token.type === 'symbol' && token.value === value;
    };

    /**
     * Whether the two tokens ahead are `.` and one of the given identifiers,
     * which is how an optional face type is told from a property that follows
     * the same dot.
     *
     * @param {readonly string[]} values
     */
    const peekDotIdentifier = values=>{
        const dot = tokens[at];
        const name = tokens[at + 1];
        return !!dot && dot.type === 'symbol' && dot.value === '.'
            && !!name && name.type === 'identifier' && values.includes(name.value);
    };

    const next = ()=>{
        const token = tokens[at];
        if (!token)
        {
            fail('the program ends in the middle of a statement');
        }
        at++;
        return /** @type {Token} */ (token);
    };

    /** @param {string} value */
    const acceptSymbol = value=>{
        if (peekSymbol(value))
        {
            at++;
            return true;
        }
        return false;
    };

    /** @param {string} value */
    const expectSymbol = value=>{
        if (!acceptSymbol(value))
        {
            fail(`'${value}' was expected`);
        }
    };

    const expectInt = ()=>{
        const token = next();
        if (token.type !== 'int')
        {
            fail('an integer was expected', token.position);
        }
        return Number(token.value);
    };

    const expectIdentifier = ()=>{
        const token = next();
        if (token.type !== 'identifier')
        {
            fail('a name was expected', token.position);
        }
        return token;
    };

    /** An identifier that may establish a name: not a reserved word. */
    const expectName = ()=>{
        const token = expectIdentifier();
        if (RESERVED.has(token.value))
        {
            fail(`'${token.value}' is a reserved word`, token.position);
        }
        return token;
    };

    /**
     * @typedef {Object} NameEntry
     * @property {'temp' | 'param' | 'attrib' | 'output' | 'address' | 'alias'} table
     * @property {ParamDecl} [decl]
     * @property {VertexBinding} [binding]
     * @property {ResultBinding} [result]
     * @property {string} [target]   the name an alias stands for
     */
    /** @type {Map<string, NameEntry>} */
    const names = new Map();

    /** @param {string} name @param {NameEntry} entry @param {number} position */
    const establish = (name, entry, position)=>{
        if (names.has(name))
        {
            fail(`'${name}' is defined twice`, position);
        }
        names.set(name, entry);
    };

    /** @param {string} name @param {number} position @returns {NameEntry} */
    const established = (name, position)=>{
        const entry = names.get(name);
        if (!entry)
        {
            fail(`'${name}' is not declared`, position);
        }
        return entry.table === 'alias'
            ? established(/** @type {string} */ (entry.target), position)
            : entry;
    };

    /** @type {string[]} */
    const temporaries = [];
    /** @type {{ name: string, target: string }[]} */
    const aliases = [];
    /** @type {ParamDecl[]} */
    const params = [];
    /** @type {{ name: string, binding: VertexBinding, position: number }[]} */
    const attribs = [];
    /** @type {{ name: string, binding: ResultBinding }[]} */
    const outputs = [];
    /** @type {Instruction[]} */
    const instructions = [];
    /** @type {string[]} */
    const options = [];
    /** @type {string[]} */
    const addressRegisters = [];
    let positionInvariant = false;
    /** @type {'fastest' | 'nicest' | null} */
    let precisionHint = null;
    /** @type {'exp' | 'exp2' | 'linear' | null} */
    let fog = null;
    /** Attribute numbers bound through a conventional name, and through attrib[n]. */
    /** @type {Map<number, number>} */
    const conventionalAttribs = new Map();
    /** @type {Map<number, number>} */
    const explicitAttribs = new Map();
    /** The fragment attribute bindings the program reads, by their text. */
    /** @type {Set<string>} */
    const fragmentBindings = new Set();

    // --- the header and the options ---

    const header = tokens[0];
    if (!header || header.type !== 'header')
    {
        fail('a program starts with !!ARBvp1.0 or !!ARBfp1.0', header?.position ?? 0);
    }
    at = 1;
    const kind = header.value === '!!ARBvp1.0' ? 'vertex'
        : header.value === '!!ARBfp1.0' ? 'fragment' : null;
    if (!kind)
    {
        fail(`'${header.value}' is not a program header this implementation takes`,
            header.position);
    }
    const vertex = kind === 'vertex';

    for (;;)
    {
        const token = peek();
        if (!token || token.type !== 'identifier' || token.value !== 'OPTION')
        {
            break;
        }
        at++;
        const option = expectIdentifier();
        if (vertex)
        {
            if (option.value !== 'ARB_position_invariant')
            {
                fail(`'${option.value}' is not a vertex program option`, option.position);
            }
            positionInvariant = true;
        }
        else
        {
            switch (option.value)
            {
                case 'ARB_precision_hint_fastest':
                    precisionHint = 'fastest';
                    break;
                case 'ARB_precision_hint_nicest':
                    precisionHint = 'nicest';
                    break;
                case 'ARB_fog_exp':
                case 'ARB_fog_exp2':
                case 'ARB_fog_linear':
                {
                    const mode = /** @type {'exp' | 'exp2' | 'linear'} */ (
                        option.value.slice('ARB_fog_'.length));
                    if (fog !== null)
                    {
                        fail('a fragment program takes only one fog option', option.position);
                    }
                    fog = mode;
                    break;
                }
                default:
                    fail(`'${option.value}' is not a fragment program option`, option.position);
            }
        }
        options.push(option.value);
        expectSymbol(';');
    }

    // --- bindings ---

    /** @returns {VertexBinding} */
    const parseVertexBinding = ()=>{
        expectSymbol('.');
        const item = expectIdentifier();
        switch (item.value)
        {
            case 'position':
            case 'normal':
            case 'fogcoord':
                return trackAttrib(
                    { kind: 'vertex', name: item.value, index: 0,
                        attrib: VERTEX_ATTRIB_OF[item.value] }, item.position);
            case 'weight':
            {
                let unit = 0;
                if (acceptSymbol('['))
                {
                    unit = expectInt();
                    expectSymbol(']');
                }
                return unit === 0
                    ? trackAttrib({ kind: 'vertex', name: 'weight', index: 0, attrib: 1 },
                        item.position)
                    : { kind: 'vertex', name: 'weight', index: unit, attrib: null };
            }
            case 'color':
            {
                // A dot not followed by a colour type is the operand's own
                // swizzle, which the caller reads.
                /** @type {'primary' | 'secondary'} */
                let colour = 'primary';
                if (peekDotIdentifier(['primary', 'secondary']))
                {
                    at++;
                    colour = /** @type {'primary' | 'secondary'} */ (next().value);
                }
                return trackAttrib(
                    { kind: 'vertex',
                        name: /** @type {'color-primary' | 'color-secondary'} */ (
                            `color-${colour}`),
                        index: 0,
                        attrib: VERTEX_ATTRIB_OF[`color-${colour}`] }, item.position);
            }
            case 'texcoord':
            {
                let index = 0;
                if (acceptSymbol('['))
                {
                    index = expectInt();
                    expectSymbol(']');
                }
                if (index < 0 || index > 7)
                {
                    fail('a texture coordinate set is 0 to 7', item.position);
                }
                return trackAttrib({ kind: 'vertex', name: 'texcoord', index, attrib: 8 + index },
                    item.position);
            }
            case 'matrixindex':
                expectSymbol('[');
                expectInt();
                expectSymbol(']');
                return { kind: 'vertex', name: 'matrixindex', index: 0, attrib: null };
            case 'attrib':
            {
                expectSymbol('[');
                const number = expectInt();
                expectSymbol(']');
                if (number < 0 || number > 15)
                {
                    fail('a generic attribute is 0 to 15', item.position);
                }
                return trackAttrib({ kind: 'vertex', name: 'attrib', index: number,
                    attrib: number }, item.position, true);
            }
            default:
                fail(`'vertex.${item.value}' is not an attribute binding`, item.position);
        }
    };

    /**
     * Notes the attribute number for the limits and for the invalid-pair rule,
     * which refuses a program binding both `vertex.position` and
     * `vertex.attrib[0]`.
     *
     * @param {VertexBinding} binding
     * @param {number} position
     * @param {boolean} [explicit]  written as vertex.attrib[n]
     */
    const trackAttrib = (binding, position, explicit)=>{
        const attrib = /** @type {number} */ (binding.attrib);
        (explicit ? explicitAttribs : conventionalAttribs).set(attrib, position);
        return binding;
    };

    /** @returns {FragmentBinding} */
    const parseFragmentBinding = ()=>{
        expectSymbol('.');
        const item = expectIdentifier();
        /** @type {FragmentBinding} */
        let binding;
        switch (item.value)
        {
            case 'position':
            case 'fogcoord':
                binding = { kind: 'fragment', name: item.value, index: 0 };
                break;
            case 'color':
            {
                /** @type {'primary' | 'secondary'} */
                let colour = 'primary';
                if (peekDotIdentifier(['primary', 'secondary']))
                {
                    at++;
                    colour = /** @type {'primary' | 'secondary'} */ (next().value);
                }
                binding = {
                    kind: 'fragment',
                    name: /** @type {'color-primary' | 'color-secondary'} */ (`color-${colour}`),
                    index: 0,
                };
                break;
            }
            case 'texcoord':
            {
                let index = 0;
                if (acceptSymbol('['))
                {
                    index = expectInt();
                    expectSymbol(']');
                }
                if (index < 0 || index > 7)
                {
                    fail('a texture coordinate set is 0 to 7', item.position);
                }
                binding = { kind: 'fragment', name: 'texcoord', index };
                break;
            }
            default:
                fail(`'fragment.${item.value}' is not an attribute binding`, item.position);
        }
        fragmentBindings.add(`${binding.name}:${binding.index}`);
        return binding;
    };

    /**
     * The result binding of either language, split by the results each has.
     *
     * @param {number} position  where `result` started
     * @returns {ResultBinding}
     */
    const parseResultBinding = position=>{
        expectSymbol('.');
        const item = expectIdentifier();
        if (!vertex && (item.value === 'color' || item.value === 'depth'))
        {
            return { kind: 'result', name: item.value, face: null, colour: null, index: 0 };
        }
        if (vertex)
        {
            switch (item.value)
            {
                case 'position':
                case 'fogcoord':
                case 'pointsize':
                    return { kind: 'result', name: item.value, face: null, colour: null,
                        index: 0 };
                case 'color':
                {
                    /** @type {'front' | 'back' | null} */
                    let face = null;
                    /** @type {'primary' | 'secondary' | null} */
                    let colour = null;
                    if (peekDotIdentifier(FACE_TYPES))
                    {
                        at++;
                        face = /** @type {'front' | 'back'} */ (next().value);
                    }
                    if (peekDotIdentifier(['primary', 'secondary']))
                    {
                        at++;
                        colour = /** @type {'primary' | 'secondary'} */ (next().value);
                    }
                    // Any other dot is the destination's write mask.
                    return { kind: 'result', name: 'color', face, colour, index: 0 };
                }
                case 'texcoord':
                {
                    let index = 0;
                    if (acceptSymbol('['))
                    {
                        index = expectInt();
                        expectSymbol(']');
                    }
                    if (index < 0 || index > 7)
                    {
                        fail('a texture coordinate result is 0 to 7', item.position);
                    }
                    return { kind: 'result', name: 'texcoord', face: null, colour: null, index };
                }
                default:
                    break;
            }
        }
        fail(`'result.${item.value}' is not a ${kind} program result`, position);
    };

    /**
     * A constant vector: one to four floats, the missing components filled as
     * the specification fills a short vertex (0, 0, 1).
     *
     * @returns {ConstantBinding}
     */
    const parseConstant = ()=>{
        expectSymbol('{');
        /** @type {number[]} */
        const values = [];
        for (;;)
        {
            let sign = 1;
            if (acceptSymbol('-'))
            {
                sign = -1;
            }
            else
            {
                acceptSymbol('+');
            }
            const token = next();
            if (token.type !== 'float' && token.type !== 'int')
            {
                fail('a constant is a number', token.position);
            }
            values.push(sign * Number(token.value));
            if (values.length > 4)
            {
                fail('a constant has at most four components', token.position);
            }
            if (acceptSymbol(','))
            {
                continue;
            }
            break;
        }
        expectSymbol('}');
        while (values.length < 3)
        {
            values.push(0);
        }
        if (values.length === 3)
        {
            values.push(1);
        }
        return { kind: 'constant', values };
    };

    /**
     * A `state.` binding. The matrices come back as rows, modifiers resolved;
     * everything else parses fully and arrives marked unsupported, with the
     * text as written for the divergence that names it.
     *
     * @param {boolean} multi  inside a `{ ... }` list, where ranges and whole
     *        matrices are legal
     * @returns {ParamBinding[]}
     */
    const parseStateBinding = multi=>{
        const start = tokens[at - 1].position;
        const slice = ()=>{
            const last = tokens[at - 1];
            return text.slice(start, last.position + last.value.length);
        };
        /** @param {UnsupportedBinding['state']} state */
        const unsupported = state=>[
            /** @type {UnsupportedBinding} */ ({ kind: 'state', state, text: slice() }),
        ];
        expectSymbol('.');
        const item = expectIdentifier();
        switch (item.value)
        {
            case 'material':
                if (peekDotIdentifier(FACE_TYPES))
                {
                    at += 2;
                }
                expectSymbol('.');
                expectIdentifier();
                return unsupported('material');
            case 'light':
            {
                expectSymbol('[');
                expectInt();
                expectSymbol(']');
                expectSymbol('.');
                const property = expectIdentifier();
                if (property.value === 'spot')
                {
                    expectSymbol('.');
                    expectIdentifier();
                }
                return unsupported('light');
            }
            case 'lightmodel':
            {
                expectSymbol('.');
                const property = expectIdentifier();
                if (FACE_TYPES.includes(property.value))
                {
                    expectSymbol('.');
                    expectIdentifier();
                }
                return unsupported('lightmodel');
            }
            case 'lightprod':
                expectSymbol('[');
                expectInt();
                expectSymbol(']');
                if (peekDotIdentifier(FACE_TYPES))
                {
                    at += 2;
                }
                expectSymbol('.');
                expectIdentifier();
                return unsupported('lightprod');
            case 'texgen':
                if (acceptSymbol('['))
                {
                    expectInt();
                    expectSymbol(']');
                }
                expectSymbol('.');
                expectIdentifier();
                expectSymbol('.');
                expectIdentifier();
                return unsupported('texgen');
            case 'fog':
                expectSymbol('.');
                expectIdentifier();
                return unsupported('fog');
            case 'clip':
                expectSymbol('[');
                expectInt();
                expectSymbol(']');
                expectSymbol('.');
                expectIdentifier();
                return unsupported('clip');
            case 'point':
                expectSymbol('.');
                expectIdentifier();
                return unsupported('point');
            case 'texenv':
                if (acceptSymbol('['))
                {
                    expectInt();
                    expectSymbol(']');
                }
                expectSymbol('.');
                expectIdentifier();
                return unsupported('texenv');
            case 'depth':
                expectSymbol('.');
                expectIdentifier();
                return unsupported('depth');
            case 'matrix':
                break;
            default:
                fail(`'state.${item.value}' is not a state binding`, item.position);
        }
        expectSymbol('.');
        const name = expectIdentifier();
        const matrix = ['modelview', 'projection', 'mvp', 'texture'].includes(name.value)
            ? /** @type {'modelview' | 'projection' | 'mvp' | 'texture'} */ (name.value)
            : null;
        const indexed = name.value === 'palette' || name.value === 'program';
        if (!matrix && !indexed)
        {
            fail(`'state.matrix.${name.value}' is not a matrix binding`, name.position);
        }
        let number = 0;
        if (indexed)
        {
            expectSymbol('[');
            number = expectInt();
            expectSymbol(']');
        }
        else if ((matrix === 'modelview' || matrix === 'texture') && acceptSymbol('['))
        {
            number = expectInt();
            expectSymbol(']');
        }
        /** @type {'' | 'inverse' | 'transpose' | 'invtrans'} */
        let modifier = '';
        if (peekDotIdentifier(MATRIX_MODIFIERS))
        {
            at++;
            modifier = /** @type {'inverse' | 'transpose' | 'invtrans'} */ (next().value);
        }
        let first = 0;
        let last = 3;
        if (peekSymbol('.'))
        {
            at++;
            const row = expectIdentifier();
            if (row.value !== 'row')
            {
                fail("'.row' was expected", row.position);
            }
            expectSymbol('[');
            first = expectInt();
            last = first;
            if (acceptSymbol('..'))
            {
                last = expectInt();
                if (!multi)
                {
                    fail('a matrix row range binds only into a parameter array', start);
                }
            }
            expectSymbol(']');
            if (first < 0 || first > 3 || last < first || last > 3)
            {
                fail('a matrix row is 0 to 3, and a range ascends', row.position);
            }
        }
        else if (!multi && !indexed)
        {
            fail('a whole matrix binds only into a parameter array', start);
        }
        if (indexed)
        {
            return unsupported(name.value === 'palette' ? 'palette' : 'program-matrix');
        }
        /** @type {MatrixBinding[]} */
        const out = [];
        for (let row = first; row <= last; row++)
        {
            out.push({
                kind: 'state', state: 'matrix',
                matrix: /** @type {'modelview' | 'projection' | 'mvp' | 'texture'} */ (matrix),
                number, modifier, row,
            });
        }
        return out;
    };

    /**
     * A `program.local`/`program.env` binding, with the range the list form
     * allows.
     *
     * @param {boolean} multi
     * @returns {ProgramParamBinding[]}
     */
    const parseProgramBinding = multi=>{
        expectSymbol('.');
        const which = expectIdentifier();
        if (which.value !== 'local' && which.value !== 'env')
        {
            fail('a program parameter is .local or .env', which.position);
        }
        expectSymbol('[');
        const first = expectInt();
        let last = first;
        if (acceptSymbol('..'))
        {
            if (!multi)
            {
                fail('a parameter range binds only into a parameter array', which.position);
            }
            last = expectInt();
        }
        expectSymbol(']');
        const limit = which.value === 'local'
            ? PROGRAM_LIMITS[kind].localParameters
            : PROGRAM_LIMITS[kind].envParameters;
        if (first < 0 || last < first || last >= limit)
        {
            fail(`a program.${which.value} parameter is 0 to ${limit - 1}`, which.position);
        }
        const kindOf = /** @type {'local' | 'env'} */ (which.value);
        /** @type {ProgramParamBinding[]} */
        const out = [];
        for (let index = first; index <= last; index++)
        {
            out.push({ kind: kindOf, index });
        }
        return out;
    };

    /**
     * One item of a parameter initialiser.
     *
     * @param {boolean} multi
     * @returns {Binding[]}
     */
    const parseParamItem = multi=>{
        if (peekSymbol('{'))
        {
            return [parseConstant()];
        }
        const token = next();
        if (token.type === 'identifier' && token.value === 'state')
        {
            return parseStateBinding(multi);
        }
        if (token.type === 'identifier' && token.value === 'program')
        {
            return parseProgramBinding(multi);
        }
        fail('a parameter binds to state, a program parameter or a constant', token.position);
    };

    /**
     * A single parameter binding written inside an instruction: the same
     * forms, minus the arrays.
     *
     * @param {'state' | 'program'} which  the keyword already read
     * @returns {ParamBinding}
     */
    const parseInlineParam = which=>(which === 'program'
        ? /** @type {ProgramParamBinding} */ (parseProgramBinding(false)[0])
        : /** @type {ParamBinding} */ (parseStateBinding(false)[0]));

    // --- declarations ---

    const parseTemp = ()=>{
        for (;;)
        {
            const name = expectName();
            establish(name.value, { table: 'temp' }, name.position);
            temporaries.push(name.value);
            if (!acceptSymbol(','))
            {
                break;
            }
        }
    };

    const parseAttrib = ()=>{
        const name = expectName();
        expectSymbol('=');
        const from = expectIdentifier();
        if (from.value !== 'vertex')
        {
            fail('an attribute binds to vertex.…', from.position);
        }
        const binding = parseVertexBinding();
        establish(name.value, { table: 'attrib', binding }, name.position);
        attribs.push({ name: name.value, binding, position: name.position });
    };

    const parseOutput = ()=>{
        const name = expectName();
        expectSymbol('=');
        const from = expectIdentifier();
        if (from.value !== 'result')
        {
            fail('an output binds to result.…', from.position);
        }
        const binding = parseResultBinding(from.position);
        establish(name.value, { table: 'output', result: binding }, name.position);
        outputs.push({ name: name.value, binding });
    };

    const parseParam = ()=>{
        const name = expectName();
        let size = -1;
        if (acceptSymbol('['))
        {
            size = expectInt();
            expectSymbol(']');
            if (size < 1)
            {
                fail('a parameter array has at least one element', name.position);
            }
        }
        expectSymbol('=');
        /** @type {Binding[]} */
        let slots;
        if (peekSymbol('{'))
        {
            if (size < 0)
            {
                // A single parameter takes a constant vector in braces.
                slots = [parseConstant()];
            }
            else
            {
                at++;
                slots = [];
                for (;;)
                {
                    slots.push(...parseParamItem(true));
                    if (acceptSymbol(','))
                    {
                        continue;
                    }
                    break;
                }
                expectSymbol('}');
                if (slots.length !== size)
                {
                    fail(`the array declares ${size} parameters and the list binds`
                        + ` ${slots.length}`, name.position);
                }
            }
        }
        else
        {
            if (size >= 0)
            {
                fail('an array declaration binds a list of parameters', name.position);
            }
            slots = parseParamItem(false);
        }
        const decl = { name: name.value, array: size >= 0, slots, position: name.position };
        establish(name.value, { table: 'param', decl }, name.position);
        params.push(decl);
    };

    // --- operands ---

    /**
     * A component suffix, normalised to four letters, or null when the source
     * carries none.
     *
     * @param {boolean} required  a scalar source, whose suffix the grammar requires
     * @param {number} position
     * @returns {string[] | null}
     */
    const parseSuffix = (required, position)=>{
        if (!acceptSymbol('.'))
        {
            if (required)
            {
                fail('a scalar source names its component', position);
            }
            return null;
        }
        const token = expectIdentifier();
        const letters = token.value;
        const xyzw = [...letters].every(c=>XYZW.includes(c));
        const rgba = [...letters].every(c=>RGBA.includes(c));
        if (!xyzw && !rgba)
        {
            fail('a swizzle is one to four xyzw or rgba components', token.position);
        }
        const toXyzw = (/** @type {string} */ c)=>(XYZW.includes(c) ? c : XYZW[RGBA.indexOf(c)]);
        if (letters.length === 1)
        {
            const c = toXyzw(letters);
            return [c, c, c, c];
        }
        if (letters.length === 4)
        {
            return [...letters].map(toXyzw);
        }
        fail('a swizzle is one or four components', token.position);
    };

    /**
     * @param {string[] | null} suffix
     * @param {boolean} negate
     * @returns {string[]}
     */
    const normalise = (suffix, negate)=>(suffix ?? ['x', 'y', 'z', 'w'])
        .map(c=>(negate ? `-${c}` : c));

    /**
     * A source register: an optional sign, then a name, an attribute binding,
     * a program or state parameter, or an inline constant.
     *
     * @param {boolean} scalar  a scalar-source instruction, whose suffix is required
     * @param {boolean} bare    a SWZ source: no sign and no suffix
     * @returns {Operand}
     */
    const parseSource = (scalar, bare)=>{
        let negate = false;
        if (!bare)
        {
            if (acceptSymbol('-'))
            {
                negate = true;
            }
            else
            {
                acceptSymbol('+');
            }
        }
        const token = next();
        if (token.type === 'symbol' && token.value === '{')
        {
            at--;
            const binding = parseConstant();
            return {
                kind: 'constant', name: null, binding, index: null, relative: null,
                components: normalise(parseSuffix(scalar, token.position), negate),
                mask: null, saturate: false, extended: false,
            };
        }
        if (token.type === 'float' || token.type === 'int')
        {
            // A literal written without braces is a scalar source: the value
            // every component takes, which is what `{ 0.2 }` means written the
            // short way. Programs of this era write `MOV R1.y, 0.2;` and a
            // driver takes it, so refusing it refuses the whole program -- and
            // a program that was not loaded is a material that draws nothing.
            const value = Number(token.value);
            return {
                kind: 'constant', name: null,
                binding: { kind: 'constant', values: [value, value, value, value] },
                index: null, relative: null,
                components: normalise(parseSuffix(scalar, token.position), negate),
                mask: null, saturate: false, extended: false,
            };
        }
        if (token.type !== 'identifier')
        {
            fail('a source register was expected', token.position);
        }
        if (token.value === (vertex ? 'vertex' : 'fragment'))
        {
            if (bare)
            {
                fail('a SWZ source is a declared name or a parameter', token.position);
            }
            const binding = vertex ? parseVertexBinding() : parseFragmentBinding();
            return {
                kind: 'attrib', name: null, binding, index: null, relative: null,
                components: normalise(parseSuffix(scalar, token.position), negate),
                mask: null, saturate: false, extended: false,
            };
        }
        if (token.value === 'program' || token.value === 'state')
        {
            const binding = parseInlineParam(
                /** @type {'state' | 'program'} */ (token.value));
            return {
                kind: 'param', name: null, binding, index: null, relative: null,
                components: normalise(bare ? null : parseSuffix(scalar, token.position), negate),
                mask: null, saturate: false, extended: false,
            };
        }
        if (token.value === 'result' || token.value === 'texture'
            || token.value === (vertex ? 'fragment' : 'vertex'))
        {
            fail(`'${token.value}' is not a source register of a ${kind} program`,
                token.position);
        }
        if (RESERVED.has(token.value))
        {
            fail(`'${token.value}' is a reserved word`, token.position);
        }
        const entry = established(token.value, token.position);
        if (entry.table === 'output')
        {
            fail('a result register cannot be read', token.position);
        }
        /** @type {Operand} */
        const operand = {
            kind: entry.table === 'param' ? 'param'
                : entry.table === 'attrib' ? 'attrib'
                    : entry.table === 'address' ? 'address' : 'temp',
            name: token.value,
            binding: null,
            index: null,
            relative: null,
            components: null,
            mask: null,
            saturate: false,
            extended: false,
        };
        if (entry.table === 'param')
        {
            const decl = /** @type {ParamDecl} */ (entry.decl);
            if (acceptSymbol('['))
            {
                if (!decl.array)
                {
                    fail(`'${token.value}' is a single parameter`, token.position);
                }
                const indexToken = next();
                if (indexToken.type === 'int')
                {
                    operand.index = Number(indexToken.value);
                    if (operand.index >= decl.slots.length)
                    {
                        fail(`'${token.value}' holds ${decl.slots.length} parameters`,
                            indexToken.position);
                    }
                }
                else if (indexToken.type === 'identifier')
                {
                    if (!vertex)
                    {
                        fail('a fragment program parameter array has no relative addressing',
                            indexToken.position);
                    }
                    const address = established(indexToken.value, indexToken.position);
                    if (address.table !== 'address')
                    {
                        fail('a relative address names the address register',
                            indexToken.position);
                    }
                    expectSymbol('.');
                    const component = expectIdentifier();
                    if (component.value !== 'x')
                    {
                        fail('a relative address reads the .x component', component.position);
                    }
                    let offset = 0;
                    if (acceptSymbol('+'))
                    {
                        offset = expectInt();
                    }
                    else if (acceptSymbol('-'))
                    {
                        offset = -expectInt();
                    }
                    operand.relative = offset;
                }
                else
                {
                    fail('a parameter index is an integer or the address register',
                        indexToken.position);
                }
                expectSymbol(']');
            }
            else if (decl.array)
            {
                fail(`'${token.value}' is a parameter array and needs an index`, token.position);
            }
        }
        if (!bare)
        {
            operand.components = normalise(parseSuffix(scalar, token.position), negate);
        }
        return operand;
    };

    /**
     * The extended swizzle of a SWZ instruction: four signed components that
     * can also be the constants 0 and 1, optionally in parentheses.
     *
     * @returns {string[]}
     */
    const parseExtendedSwizzle = ()=>{
        const parenthesised = acceptSymbol('(');
        /** @type {string[]} */
        const out = [];
        for (let i = 0; i < 4; i++)
        {
            if (i > 0)
            {
                expectSymbol(',');
            }
            let sign = '';
            if (acceptSymbol('-'))
            {
                sign = '-';
            }
            else
            {
                acceptSymbol('+');
            }
            const token = next();
            if (token.type === 'int' && (token.value === '0' || token.value === '1'))
            {
                out.push(sign + token.value);
                continue;
            }
            if (token.type === 'identifier' && token.value.length === 1
                && (XYZW.includes(token.value) || (!vertex && RGBA.includes(token.value))))
            {
                const c = XYZW.includes(token.value) ? token.value
                    : XYZW[RGBA.indexOf(token.value)];
                out.push(sign + c);
                continue;
            }
            fail('an extended swizzle component is 0, 1 or one of xyzw', token.position);
        }
        if (parenthesised)
        {
            expectSymbol(')');
        }
        return out;
    };

    /**
     * A write mask, normalised to ascending xyzw letters, or the full mask
     * when the destination carries none.
     *
     * @returns {string}
     */
    const parseMask = ()=>{
        if (!acceptSymbol('.'))
        {
            return 'xyzw';
        }
        const token = expectIdentifier();
        const toXyzw = (/** @type {string} */ c)=>(XYZW.includes(c) ? c : XYZW[RGBA.indexOf(c)]);
        const letters = [...token.value].map(toXyzw).join('');
        if (!MASK_ORDER.includes(letters))
        {
            fail('a write mask lists xyzw components once each, in order', token.position);
        }
        return letters;
    };

    /** @returns {Operand} */
    const parseDestination = ()=>{
        const token = next();
        if (token.type !== 'identifier')
        {
            fail('a destination register was expected', token.position);
        }
        /** @type {Operand} */
        let operand;
        if (token.value === 'result')
        {
            operand = {
                kind: 'output', name: null, binding: parseResultBinding(token.position),
                index: null, relative: null, components: null, mask: null, saturate: false,
                extended: false,
            };
        }
        else
        {
            if (RESERVED.has(token.value))
            {
                fail(`'${token.value}' is a reserved word`, token.position);
            }
            const entry = established(token.value, token.position);
            if (entry.table === 'param' || entry.table === 'attrib')
            {
                fail('an attribute or a parameter cannot be written', token.position);
            }
            operand = {
                kind: entry.table === 'address' ? 'address'
                    : entry.table === 'output' ? 'output' : 'temp',
                name: token.value,
                binding: entry.table === 'output' ? /** @type {ResultBinding} */ (entry.result)
                    : null,
                index: null,
                relative: null,
                components: null,
                mask: null,
                saturate: false,
                extended: false,
            };
        }
        if (operand.kind === 'address')
        {
            expectSymbol('.');
            const component = expectIdentifier();
            if (component.value !== 'x')
            {
                fail('the address register writes .x', component.position);
            }
            operand.mask = 'x';
        }
        else
        {
            operand.mask = parseMask();
        }
        if (positionInvariant && operand.binding?.kind === 'result'
            && operand.binding.name === 'position')
        {
            fail('a position-invariant program does not write result.position', token.position);
        }
        return operand;
    };

    // --- instructions ---

    const parseInstruction = ()=>{
        const token = next();
        if (token.type !== 'identifier')
        {
            fail('an instruction, a declaration or END was expected', token.position);
        }
        let op = token.value;
        let saturate = false;
        if (!vertex && op.endsWith('_SAT'))
        {
            saturate = true;
            op = op.slice(0, -4);
        }
        const shape = OPCODES[kind][op];
        if (!shape)
        {
            fail(`'${token.value}' is not a ${kind} program instruction`, token.position);
        }
        /** @type {Instruction} */
        const instruction = { op, saturate, dst: null, src: [], texture: null };
        if (shape === 'kil')
        {
            instruction.src = [parseSource(false, false)];
            instructions.push(instruction);
            return;
        }
        instruction.dst = parseDestination();
        if (shape === 'addr' && instruction.dst.kind !== 'address')
        {
            fail('ARL writes the address register', token.position);
        }
        if (shape !== 'addr' && instruction.dst.kind === 'address')
        {
            fail('only ARL writes the address register', token.position);
        }
        expectSymbol(',');
        if (shape === 'tex')
        {
            instruction.src = [parseSource(false, false)];
            expectSymbol(',');
            const unit = expectIdentifier();
            if (unit.value !== 'texture')
            {
                fail('a texture instruction samples texture[n]', unit.position);
            }
            let index = 0;
            if (acceptSymbol('['))
            {
                index = expectInt();
                expectSymbol(']');
            }
            if (index < 0 || index > 15)
            {
                fail('a texture image unit is 0 to 15', unit.position);
            }
            expectSymbol(',');
            const target = expectIdentifier();
            if (!['1D', '2D', '3D', 'CUBE', 'RECT'].includes(target.value))
            {
                fail('a texture target is 1D, 2D, 3D, CUBE or RECT', target.position);
            }
            instruction.texture = {
                unit: index,
                target: /** @type {'1D' | '2D' | '3D' | 'CUBE' | 'RECT'} */ (target.value),
            };
            instructions.push(instruction);
            return;
        }
        if (shape === 'swz')
        {
            // The grammar reads the source bare, but the specification's own
            // example negates one; the negation folds into the components.
            let negate = false;
            if (acceptSymbol('-'))
            {
                negate = true;
            }
            else
            {
                acceptSymbol('+');
            }
            const source = parseSource(false, true);
            expectSymbol(',');
            const components = parseExtendedSwizzle();
            source.components = negate
                ? components.map(c=>(c.startsWith('-') ? c.slice(1) : `-${c}`))
                : components;
            source.extended = true;
            instruction.src = [source];
            instructions.push(instruction);
            return;
        }
        const scalar = shape === 'scalar' || shape === 'binscalar';
        for (let i = 0, count = sourceCount(shape); i < count; i++)
        {
            if (i > 0)
            {
                expectSymbol(',');
            }
            instruction.src.push(parseSource(scalar, false));
        }
        instructions.push(instruction);
    };

    // --- the statement loop ---

    for (;;)
    {
        const token = peek();
        if (!token)
        {
            fail('END was expected', text.length);
        }
        if (token.type === 'identifier' && token.value === 'END')
        {
            at++;
            break;
        }
        if (token.type === 'identifier' && token.value === 'OPTION')
        {
            fail('the options precede the statements', token.position);
        }
        if (token.type === 'identifier')
        {
            switch (token.value)
            {
                case 'TEMP':
                    at++;
                    parseTemp();
                    expectSymbol(';');
                    continue;
                case 'ADDRESS':
                    if (!vertex)
                    {
                        fail('a fragment program has no address register', token.position);
                    }
                    at++;
                    for (;;)
                    {
                        const name = expectName();
                        establish(name.value, { table: 'address' }, name.position);
                        addressRegisters.push(name.value);
                        if (!acceptSymbol(','))
                        {
                            break;
                        }
                    }
                    expectSymbol(';');
                    continue;
                case 'ALIAS':
                {
                    at++;
                    const name = expectName();
                    expectSymbol('=');
                    const target = expectName();
                    established(target.value, target.position);
                    establish(name.value, { table: 'alias', target: target.value }, name.position);
                    aliases.push({ name: name.value, target: target.value });
                    expectSymbol(';');
                    continue;
                }
                case 'ATTRIB':
                    if (!vertex)
                    {
                        fail('a fragment program declares no attributes', token.position);
                    }
                    at++;
                    parseAttrib();
                    expectSymbol(';');
                    continue;
                case 'OUTPUT':
                    at++;
                    parseOutput();
                    expectSymbol(';');
                    continue;
                case 'PARAM':
                    at++;
                    parseParam();
                    expectSymbol(';');
                    continue;
                default:
                    break;
            }
        }
        parseInstruction();
        expectSymbol(';');
    }
    if (at < tokens.length)
    {
        fail('nothing follows END');
    }

    // --- the semantic restrictions and the limits ---

    for (const [attrib, position] of explicitAttribs)
    {
        if (conventionalAttribs.has(attrib))
        {
            fail(`vertex.attrib[${attrib}] is bound conventionally as well`, position);
        }
    }
    let tex = 0;
    for (const instruction of instructions)
    {
        if (instruction.texture)
        {
            tex++;
        }
    }
    const counts = {
        instructions: instructions.length,
        alu: instructions.length - tex,
        tex,
        temporaries: temporaries.length,
        parameters: params.reduce((sum, decl)=>sum + decl.slots.length, 0),
        attribs: vertex ? new Set([...conventionalAttribs.keys(), ...explicitAttribs.keys()]).size
            : fragmentBindings.size,
        addressRegisters: addressRegisters.length,
    };
    /**
     * @param {number} value
     * @param {number} limit
     * @param {string} what
     */
    const over = (value, limit, what)=>{
        if (value > limit)
        {
            fail(`the program holds ${value} ${what} and the limit is ${limit}`, text.length);
        }
    };
    over(counts.instructions, PROGRAM_LIMITS[kind].instructions, 'instructions');
    over(counts.temporaries, PROGRAM_LIMITS[kind].temporaries, 'temporaries');
    over(counts.parameters, PROGRAM_LIMITS[kind].parameters, 'parameters');
    over(counts.attribs, PROGRAM_LIMITS[kind].attribs, 'attributes');
    if (vertex)
    {
        over(counts.addressRegisters, PROGRAM_LIMITS.vertex.addressRegisters,
            'address registers');
    }
    else
    {
        over(counts.alu, PROGRAM_LIMITS.fragment.aluInstructions, 'arithmetic instructions');
        over(counts.tex, PROGRAM_LIMITS.fragment.texInstructions, 'texture instructions');
    }

    return {
        kind,
        options,
        positionInvariant,
        precisionHint,
        fog,
        temporaries,
        address: addressRegisters[0] ?? null,
        aliases,
        params,
        attribs,
        outputs,
        instructions,
        counts,
    };
}
