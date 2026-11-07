/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A SPIR-V module's words read into what the lifter (`spirv-glsl.js`) walks
 * (SPIR-V 1.0 specification, section 2.3 "Physical Layout" and 2.4 "Logical
 * Layout"): the header, the capabilities and imports, the entry points and
 * their execution modes, the debug names, the decorations, the global
 * declarations in their order, and each function's blocks.
 *
 * - **The words are the module**: a module given byte-swapped (its magic
 *   number read as 0x03022307) is read swapped, as section 2.3 allows.
 * - **An instruction is its words**: `operands` are the words past the
 *   result type and result id, which each instruction's own reading takes
 *   apart; literal strings are read where an instruction has one.
 * - **What is not a valid module is said**: a wrong magic number, an
 *   instruction running past the end or of no words, a function not ended.
 */

/** The opcodes this reader and the lifter name (SPIR-V 1.0 section 3.32). */
export const Op = Object.freeze({
    Nop: 0, Undef: 1, SourceContinued: 2, Source: 3, SourceExtension: 4, Name: 5,
    MemberName: 6, String: 7, Line: 8, Extension: 10, ExtInstImport: 11, ExtInst: 12,
    MemoryModel: 14, EntryPoint: 15, ExecutionMode: 16, Capability: 17, TypeVoid: 19,
    TypeBool: 20, TypeInt: 21, TypeFloat: 22, TypeVector: 23, TypeMatrix: 24, TypeImage: 25,
    TypeSampler: 26, TypeSampledImage: 27, TypeArray: 28, TypeRuntimeArray: 29,
    TypeStruct: 30, TypeOpaque: 31, TypePointer: 32, TypeFunction: 33, ConstantTrue: 41,
    ConstantFalse: 42, Constant: 43, ConstantComposite: 44, ConstantSampler: 45,
    ConstantNull: 46, SpecConstantTrue: 48, SpecConstantFalse: 49, SpecConstant: 50,
    SpecConstantComposite: 51, SpecConstantOp: 52, Function: 54, FunctionParameter: 55,
    FunctionEnd: 56, FunctionCall: 57, Variable: 59, ImageTexelPointer: 60, Load: 61,
    Store: 62, CopyMemory: 63, AccessChain: 65, InBoundsAccessChain: 66, PtrAccessChain: 67,
    ArrayLength: 68, Decorate: 71, MemberDecorate: 72, DecorationGroup: 73,
    GroupDecorate: 74, GroupMemberDecorate: 75, VectorExtractDynamic: 77,
    VectorInsertDynamic: 78, VectorShuffle: 79, CompositeConstruct: 80,
    CompositeExtract: 81, CompositeInsert: 82, CopyObject: 83, Transpose: 84,
    SampledImage: 86, ImageSampleImplicitLod: 87, ImageSampleExplicitLod: 88,
    ImageSampleDrefImplicitLod: 89, ImageSampleDrefExplicitLod: 90,
    ImageSampleProjImplicitLod: 91, ImageSampleProjExplicitLod: 92,
    ImageSampleProjDrefImplicitLod: 93, ImageSampleProjDrefExplicitLod: 94, ImageFetch: 95,
    ImageGather: 96, ImageDrefGather: 97, ImageRead: 98, ImageWrite: 99, Image: 100,
    ImageQueryFormat: 101, ImageQueryOrder: 102, ImageQuerySizeLod: 103, ImageQuerySize: 104,
    ImageQueryLod: 105, ImageQueryLevels: 106, ImageQuerySamples: 107, ConvertFToU: 109,
    ConvertFToS: 110, ConvertSToF: 111, ConvertUToF: 112, UConvert: 113, SConvert: 114,
    FConvert: 115, QuantizeToF16: 116, Bitcast: 124, SNegate: 126, FNegate: 127, IAdd: 128,
    FAdd: 129, ISub: 130, FSub: 131, IMul: 132, FMul: 133, UDiv: 134, SDiv: 135, FDiv: 136,
    UMod: 137, SRem: 138, SMod: 139, FRem: 140, FMod: 141, VectorTimesScalar: 142,
    MatrixTimesScalar: 143, VectorTimesMatrix: 144, MatrixTimesVector: 145,
    MatrixTimesMatrix: 146, OuterProduct: 147, Dot: 148, IAddCarry: 149, ISubBorrow: 150,
    UMulExtended: 151, SMulExtended: 152, Any: 154, All: 155, IsNan: 156, IsInf: 157,
    LogicalEqual: 164, LogicalNotEqual: 165, LogicalOr: 166, LogicalAnd: 167,
    LogicalNot: 168, Select: 169, IEqual: 170, INotEqual: 171, UGreaterThan: 172,
    SGreaterThan: 173, UGreaterThanEqual: 174, SGreaterThanEqual: 175, ULessThan: 176,
    SLessThan: 177, ULessThanEqual: 178, SLessThanEqual: 179, FOrdEqual: 180,
    FUnordEqual: 181, FOrdNotEqual: 182, FUnordNotEqual: 183, FOrdLessThan: 184,
    FUnordLessThan: 185, FOrdGreaterThan: 186, FUnordGreaterThan: 187,
    FOrdLessThanEqual: 188, FUnordLessThanEqual: 189, FOrdGreaterThanEqual: 190,
    FUnordGreaterThanEqual: 191, ShiftRightLogical: 194, ShiftRightArithmetic: 195,
    ShiftLeftLogical: 196, BitwiseOr: 197, BitwiseXor: 198, BitwiseAnd: 199, Not: 200,
    BitFieldInsert: 201, BitFieldSExtract: 202, BitFieldUExtract: 203, BitReverse: 204,
    BitCount: 205, DPdx: 207, DPdy: 208, Fwidth: 209, DPdxFine: 210, DPdyFine: 211,
    FwidthFine: 212, DPdxCoarse: 213, DPdyCoarse: 214, FwidthCoarse: 215, EmitVertex: 218,
    EndPrimitive: 219, EmitStreamVertex: 220, EndStreamPrimitive: 221, ControlBarrier: 224,
    MemoryBarrier: 225, AtomicLoad: 227, AtomicStore: 228, AtomicExchange: 229,
    AtomicCompareExchange: 230, AtomicCompareExchangeWeak: 231, AtomicIIncrement: 232,
    AtomicIDecrement: 233, AtomicIAdd: 234, AtomicISub: 235, AtomicSMin: 236,
    AtomicUMin: 237, AtomicSMax: 238, AtomicUMax: 239, AtomicAnd: 240, AtomicOr: 241,
    AtomicXor: 242, Phi: 245, LoopMerge: 246, SelectionMerge: 247, Label: 248, Branch: 249,
    BranchConditional: 250, Switch: 251, Kill: 252, Return: 253, ReturnValue: 254,
    Unreachable: 255, NoLine: 317, ModuleProcessed: 330, ExecutionModeId: 331,
    DecorateId: 332, TerminateInvocation: 4416,
});

/**
 * The opcodes whose instruction has a result id and no result type (section
 * 3.32: the types, a label, an import, a string, a decoration group).
 *
 * @type {ReadonlySet<number>}
 */
const RESULT_ONLY = new Set([Op.ExtInstImport, Op.String, Op.TypeVoid, Op.TypeBool,
    Op.TypeInt, Op.TypeFloat, Op.TypeVector, Op.TypeMatrix, Op.TypeImage, Op.TypeSampler,
    Op.TypeSampledImage, Op.TypeArray, Op.TypeRuntimeArray, Op.TypeStruct, Op.TypeOpaque,
    Op.TypePointer, Op.TypeFunction, Op.Label, Op.DecorationGroup]);

/** The opcodes with no result at all. @type {ReadonlySet<number>} */
const NO_RESULT = new Set([Op.Nop, Op.SourceContinued, Op.Source, Op.SourceExtension, Op.Name,
    Op.MemberName, Op.Line, Op.Extension, Op.MemoryModel, Op.EntryPoint, Op.ExecutionMode,
    Op.Capability, Op.FunctionEnd, Op.Store, Op.CopyMemory, Op.Decorate, Op.MemberDecorate,
    Op.GroupDecorate, Op.GroupMemberDecorate, Op.ImageWrite, Op.EmitVertex, Op.EndPrimitive,
    Op.EmitStreamVertex, Op.EndStreamPrimitive, Op.ControlBarrier, Op.MemoryBarrier,
    Op.AtomicStore, Op.LoopMerge, Op.SelectionMerge, Op.Branch, Op.BranchConditional,
    Op.Switch, Op.Kill, Op.Return, Op.ReturnValue, Op.Unreachable, Op.NoLine,
    Op.ModuleProcessed, Op.ExecutionModeId, Op.DecorateId, Op.TerminateInvocation]);

/** The decorations the lifter reads (section 3.20). */
export const Decoration = Object.freeze({
    RelaxedPrecision: 0, SpecId: 1, Block: 2, BufferBlock: 3, RowMajor: 4, ColMajor: 5,
    ArrayStride: 6, MatrixStride: 7, GLSLShared: 8, GLSLPacked: 9, BuiltIn: 11,
    NoPerspective: 13, Flat: 14, Patch: 15, Centroid: 16, Sample: 17, Invariant: 18,
    Restrict: 19, Aliased: 20, Volatile: 21, Constant: 22, Coherent: 23, NonWritable: 24,
    NonReadable: 25, Uniform: 26, XfbBuffer: 36, XfbStride: 37, Location: 30, Component: 31,
    Index: 32, Binding: 33, DescriptorSet: 34, Offset: 35, Stream: 29,
    NoContraction: 42,
});

/**
 * One instruction: its opcode, result type and id where it has them, and the
 * words past those.
 *
 * @typedef {Object} Instruction
 * @property {number} op
 * @property {number} type  its result type, 0 where it has none
 * @property {number} id  its result id, 0 where it has none
 * @property {Uint32Array} operands
 */

/**
 * A block of a function: its label, its instructions past the label, the
 * last of them its terminator.
 *
 * @typedef {Object} Block
 * @property {number} label
 * @property {Instruction[]} body
 */

/**
 * @typedef {Object} SpirvFunction
 * @property {number} id
 * @property {number} type  its return type
 * @property {number} functionType
 * @property {Instruction[]} params
 * @property {Block[]} blocks
 */

/**
 * @typedef {Object} SpirvModule
 * @property {number} version  the header's (0x00010000 for 1.0)
 * @property {number} bound
 * @property {number[]} capabilities
 * @property {string[]} extensions
 * @property {Map<number, string>} imports  an OpExtInstImport's id to its set's name
 * @property {{ model: number, id: number, name: string, interface: number[] }[]} entryPoints
 * @property {Map<number, { mode: number, operands: number[] }[]>} modes  by entry point
 * @property {Map<number, string>} names
 * @property {Map<number, Map<number, number[]>>} decorations  an id's, each with its operands
 * @property {Map<number, Map<number, Map<number, number[]>>>} memberDecorations
 * @property {Map<number, Instruction>} globals  every type, constant and global variable
 * @property {number[]} order  the global declarations' ids in the module's order
 * @property {SpirvFunction[]} functions
 */

/** SPIR-V's magic number (section 3.1). */
export const SPIRV_MAGIC = 0x07230203;

/**
 * A literal string's text and how many words it takes (section 2.2.1:
 * UTF-8 bytes, nul-terminated, padded to a word).
 *
 * @param {Uint32Array} words @param {number} at
 * @returns {{ text: string, words: number }}
 */
export function literalString(words, at){
    /** @type {number[]} */
    const bytes = [];
    let k = at;
    for (; k < words.length; k++)
    {
        const word = words[k];
        let ended = false;
        for (let b = 0; b < 4; b++)
        {
            const byte = (word >>> (b * 8)) & 0xff;
            if (byte === 0)
            {
                ended = true;
                break;
            }
            bytes.push(byte);
        }
        if (ended)
        {
            break;
        }
    }
    return { text: new TextDecoder().decode(new Uint8Array(bytes)), words: k - at + 1 };
}

/**
 * The module in `bytes`, or why it is none.
 *
 * @param {Uint8Array} bytes
 * @returns {{ module: SpirvModule } | { error: string }}
 */
export function readSpirv(bytes){
    if (bytes.length < 20 || bytes.length % 4 !== 0)
    {
        return { error: 'a SPIR-V module is whole words, five of them its header at least' };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint32(0, true) === SPIRV_MAGIC;
    if (!little && view.getUint32(0, false) !== SPIRV_MAGIC)
    {
        return { error: 'the binary does not start with SPIR-V\'s magic number' };
    }
    const words = new Uint32Array(bytes.length / 4);
    for (let k = 0; k < words.length; k++)
    {
        words[k] = view.getUint32(k * 4, little);
    }
    /** @type {SpirvModule} */
    const module = {
        version: words[1], bound: words[3], capabilities: [], extensions: [],
        imports: new Map(), entryPoints: [], modes: new Map(), names: new Map(),
        decorations: new Map(), memberDecorations: new Map(), globals: new Map(), order: [],
        functions: [],
    };
    /** @type {SpirvFunction | null} */
    let fn = null;
    /** @type {Block | null} */
    let block = null;
    /** @type {Map<number, Map<number, number[]>>} a decoration group's decorations */
    const groups = new Map();
    for (let at = 5; at < words.length;)
    {
        const count = words[at] >>> 16;
        const op = words[at] & 0xffff;
        if (count === 0 || at + count > words.length)
        {
            return { error: `an instruction at word ${at} runs past the module's end` };
        }
        const all = words.subarray(at, at + count);
        at += count;
        let k = 1;
        const type = !RESULT_ONLY.has(op) && !NO_RESULT.has(op) ? all[k++] ?? 0 : 0;
        const id = !NO_RESULT.has(op) ? all[k++] ?? 0 : 0;
        /** @type {Instruction} */
        const instruction = { op, type, id, operands: all.subarray(k) };
        const o = instruction.operands;
        switch (op)
        {
            case Op.Capability:
                module.capabilities.push(o[0]);
                continue;
            case Op.Extension:
                module.extensions.push(literalString(o, 0).text);
                continue;
            case Op.ExtInstImport:
                module.imports.set(id, literalString(o, 0).text);
                continue;
            case Op.EntryPoint: {
                const name = literalString(o, 2);
                module.entryPoints.push({ model: o[0], id: o[1], name: name.text,
                    interface: Array.from(o.subarray(2 + name.words)) });
                continue;
            }
            case Op.ExecutionMode:
            case Op.ExecutionModeId: {
                const list = module.modes.get(o[0]) ?? [];
                list.push({ mode: o[1], operands: Array.from(o.subarray(2)) });
                module.modes.set(o[0], list);
                continue;
            }
            case Op.Name:
                module.names.set(o[0], literalString(o, 1).text);
                continue;
            case Op.Decorate:
            case Op.DecorateId: {
                const own = module.decorations.get(o[0]) ?? new Map();
                own.set(o[1], Array.from(o.subarray(2)));
                module.decorations.set(o[0], own);
                continue;
            }
            case Op.MemberDecorate: {
                const members = module.memberDecorations.get(o[0]) ?? new Map();
                const own = members.get(o[1]) ?? new Map();
                own.set(o[2], Array.from(o.subarray(3)));
                members.set(o[1], own);
                module.memberDecorations.set(o[0], members);
                continue;
            }
            case Op.DecorationGroup:
                // The group's decorations were given to its id before it.
                groups.set(id, module.decorations.get(id) ?? new Map());
                continue;
            case Op.GroupDecorate:
                for (const target of o.subarray(1))
                {
                    const own = module.decorations.get(target) ?? new Map();
                    for (const [decoration, values] of groups.get(o[0]) ?? [])
                    {
                        own.set(decoration, values);
                    }
                    module.decorations.set(target, own);
                }
                continue;
            case Op.GroupMemberDecorate:
                for (let p = 1; p + 1 < o.length; p += 2)
                {
                    const members = module.memberDecorations.get(o[p]) ?? new Map();
                    const own = members.get(o[p + 1]) ?? new Map();
                    for (const [decoration, values] of groups.get(o[0]) ?? [])
                    {
                        own.set(decoration, values);
                    }
                    members.set(o[p + 1], own);
                    module.memberDecorations.set(o[p], members);
                }
                continue;
            case Op.MemberName:
            case Op.Source:
            case Op.SourceContinued:
            case Op.SourceExtension:
            case Op.String:
            case Op.Line:
            case Op.NoLine:
            case Op.Nop:
            case Op.MemoryModel:
            case Op.ModuleProcessed:
                continue;
            case Op.Function:
                if (fn)
                {
                    return { error: 'a function begins inside another' };
                }
                fn = { id, type, functionType: o[1], params: [], blocks: [] };
                continue;
            case Op.FunctionParameter:
                if (!fn)
                {
                    return { error: 'a function parameter outside a function' };
                }
                fn.params.push(instruction);
                continue;
            case Op.FunctionEnd:
                if (!fn)
                {
                    return { error: 'a function ends that did not begin' };
                }
                module.functions.push(fn);
                fn = null;
                block = null;
                continue;
            case Op.Label:
                if (!fn)
                {
                    return { error: 'a label outside a function' };
                }
                block = { label: id, body: [] };
                fn.blocks.push(block);
                continue;
            default:
                break;
        }
        if (fn)
        {
            if (!block)
            {
                return { error: `an instruction (opcode ${op}) before a function's first label` };
            }
            block.body.push(instruction);
            continue;
        }
        module.globals.set(id, instruction);
        module.order.push(id);
    }
    if (fn)
    {
        return { error: 'the module ends inside a function' };
    }
    return { module };
}
