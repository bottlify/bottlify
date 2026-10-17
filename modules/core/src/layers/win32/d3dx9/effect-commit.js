/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ID3DXEffect::CommitChanges, BeginPass and EndPass, and Begin, End,
 * SetTechnique and GetTechnique around them, as code in the guest: a program
 * begins a technique and a pass and commits before almost every draw,
 * thousands of times a second, and each was a crossing into the host that
 * walked the pass's states to set them. Compiled by the build
 * (`scripts/guest-code/`) into `effect-commit.x86.js`, they run in the
 * methods' vtable slots, and `Walk` where the effect's block names it.
 *
 * Each walks the pass's table (`COMMIT` in `effect.js`), which the host
 * compiled from the pass in the order the host's own BeginPass sets things:
 * for each entry -- at BeginPass every one, at a commit those whose
 * parameter's store is dated after the pass was last applied -- it calls the
 * device's setter through the device's vtable -- the setter's command
 * routine, which writes it into the ring -- or the program's state
 * manager's, with the value the host would have set. Then it dates the pass,
 * as the host does. A pass with no table (one with a state the table cannot
 * say), a table's trigger dated after the pass (a sampler the program set
 * whole) at a commit, and a pass the host has not begun once are the host's:
 * the call goes to the host's method as it came.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../msvcrt/guest-code.js').f64} f64 */
/**
 * @typedef {Pick<Guest, 'u32' | 'i32' | 'f32' | 'f64' | 'setU32' | 'setF32' | 'setF64'
 *     | 'controlWord' | 'setControlWord'>} Evaluating
 */

/**
 * The effect block's words (`EFFECT_BLOCK`): the clock, the table, the pass,
 * the passes, Walk, whether a technique is begun and its Begin flags, the
 * current technique's record and the techniques.
 */
const BLOCK_CLOCK = 12;
const BLOCK_COMMIT = 16;
const BLOCK_ACTIVE = 20;
const BLOCK_PASSES = 24;
const BLOCK_WALK = 28;
const BLOCK_STARTED = 32;
const BLOCK_FLAGS = 36;
const BLOCK_TECHNIQUE = 40;
const BLOCK_TECHNIQUES = 44;
/** A technique's record (`TECHNIQUE`): its passes, its state blocks by what Begin keeps. */
const TECHNIQUE_PASSES = 0;
const TECHNIQUE_SAVED = 4;
/** D3DXFX_DONOTSAVESTATE, and the two flags that choose a state block. */
const DONOTSAVESTATE = 1;
const KEEPS = 6;
/** IDirect3DStateBlock9's Capture and Apply. */
const CAPTURE = 4;
const APPLY = 5;
/** A table's header: device, where the pass's date is, entries, scratch, triggers, stale pairs. */
const STALE = 20;
const HEADER = 24;
/** An entry: kind, version, setter's slot, two arguments, data, mode, arity. */
const ENTRY = 32;
/** An expression's cell (`CELL`): the state's word, the date it was worked out, its program. */
const CELL_DATE = 4;
const CELL_PROGRAM = 8;
/**
 * Its program (`EXPRESSION`): how many inputs and instructions, the registers
 * (doubles), how many, the first the literals do not fill, the result's
 * register and how it becomes the state's word; then each input (the
 * parameter's data, its type -- 0 float, 1 int, 2 bool -- how many words, the
 * first register, how many registers' components apart its words land) and
 * each instruction (opcode, inputs, components, whether
 * the first input is one component, the three inputs' registers, the output's).
 */
const EXPRESSION_INPUT = 28;
const INPUT_SIZE = 20;
const INSTRUCTION_SIZE = 32;
/** The x87 control word an expression is worked out under: doubles, nearest, all masked. */
const DOUBLES = 0x27f;

/**
 * HRESULT CommitChanges()
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function CommitChanges({ u32, i32, f32, f64, setU32, setF32, setF64, controlWord,
    setControlWord, callStd, host }, self)
{
    const block = u32(self + 4);
    if (block === 0)
    {
        return host();
    }
    // No pass begun: nothing to commit, D3D_OK, as the host answers it -- a
    // program that commits outside its passes did so ten thousand times a second.
    if (u32(block + BLOCK_ACTIVE) === 0)
    {
        return 0;
    }
    const table = u32(block + BLOCK_COMMIT);
    if (table === 0)
    {
        return host();
    }
    const applied = u32(u32(table + 4));
    const triggers = u32(table + 16);
    for (let t = 0; t < (triggers | 0); t++)
    {
        if (u32(u32(table + HEADER + t * 4)) > applied)
        {
            return host();
        }
    }
    // An expression's input written after its cell was worked out: the cell
    // is worked out again here when the host left it a program, else the call
    // is the host's -- found before anything is written.
    const pairs = (table + HEADER + u32(table + 16) * 4) >>> 0;
    const pairsEnd = (pairs + u32(table + STALE) * 8) >>> 0;
    let pair = pairs;
    while (pair < pairsEnd)
    {
        if (u32(u32(pair)) > u32(u32(pair + 4))
            && u32(u32(pair + 4) - CELL_DATE + CELL_PROGRAM) === 0)
        {
            return host();
        }
        pair = (pair + 8) >>> 0;
    }
    pair = pairs;
    while (pair < pairsEnd)
    {
        if (u32(u32(pair)) > u32(u32(pair + 4)))
        {
            Evaluate({ u32, i32, f32, f64, setU32, setF32, setF64, controlWord, setControlWord },
                (u32(pair + 4) - CELL_DATE) >>> 0, u32(block + BLOCK_CLOCK));
        }
        pair = (pair + 8) >>> 0;
    }
    return callStd(u32(block + BLOCK_WALK), block, table, 0) >>> 0;
}

/**
 * HRESULT BeginPass(UINT Pass)
 *
 * The passes of the technique begun are at the block's PASSES, a count and
 * then each pass's table and its number; the block's ACTIVE is the number of
 * the pass begun, 0 for none.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} index
 * @returns {u32}
 */
export function BeginPass({ u32, i32, f32, f64, setU32, setF32, setF64, controlWord,
    setControlWord, callStd, host }, self, index)
{
    const block = u32(self + 4);
    if (block === 0)
    {
        return host();
    }
    const passes = u32(block + BLOCK_PASSES);
    if (passes === 0 || u32(block + BLOCK_ACTIVE) !== 0 || index >= u32(passes))
    {
        return host();
    }
    const table = u32(passes + 4 + index * 8);
    if (table === 0)
    {
        return host();
    }
    // An expression's input written after its cell was worked out: the cell
    // is worked out again here when the host left it a program, else the call
    // is the host's -- found before anything is written.
    const pairs = (table + HEADER + u32(table + 16) * 4) >>> 0;
    const pairsEnd = (pairs + u32(table + STALE) * 8) >>> 0;
    let pair = pairs;
    while (pair < pairsEnd)
    {
        if (u32(u32(pair)) > u32(u32(pair + 4))
            && u32(u32(pair + 4) - CELL_DATE + CELL_PROGRAM) === 0)
        {
            return host();
        }
        pair = (pair + 8) >>> 0;
    }
    pair = pairs;
    while (pair < pairsEnd)
    {
        if (u32(u32(pair)) > u32(u32(pair + 4)))
        {
            Evaluate({ u32, i32, f32, f64, setU32, setF32, setF64, controlWord, setControlWord },
                (u32(pair + 4) - CELL_DATE) >>> 0, u32(block + BLOCK_CLOCK));
        }
        pair = (pair + 8) >>> 0;
    }
    setU32(block + BLOCK_ACTIVE, u32(passes + 8 + index * 8));
    setU32(block + BLOCK_COMMIT, table);
    const answer = callStd(u32(block + BLOCK_WALK), block, table, 1) >>> 0;
    if (answer !== 0)
    {
        setU32(block + BLOCK_ACTIVE, 0);
        setU32(block + BLOCK_COMMIT, 0);
    }
    return answer;
}

/**
 * HRESULT EndPass()
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function EndPass({ u32, setU32, host }, self){
    const block = u32(self + 4);
    if (block === 0 || u32(block + BLOCK_ACTIVE) === 0)
    {
        return host();
    }
    setU32(block + BLOCK_ACTIVE, 0);
    setU32(block + BLOCK_COMMIT, 0);
    return 0;
}

/**
 * HRESULT Begin(UINT *pPasses, DWORD Flags)
 *
 * A technique whose state the flags keep and has no state block yet, made
 * the first time, is the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} passesOut @param {u32} flags
 * @returns {u32}
 */
export function Begin({ u32, setU32, callStd, host }, self, passesOut, flags){
    const block = u32(self + 4);
    if (block === 0)
    {
        return host();
    }
    const technique = u32(block + BLOCK_TECHNIQUE);
    if (technique === 0)
    {
        return host();
    }
    const saved = (flags & DONOTSAVESTATE) !== 0 ? 0
        : u32(technique + TECHNIQUE_SAVED + (flags & KEEPS) * 2);
    if ((flags & DONOTSAVESTATE) === 0 && saved === 0)
    {
        return host();
    }
    const passes = u32(technique + TECHNIQUE_PASSES);
    if (passesOut !== 0)
    {
        setU32(passesOut, u32(passes));
    }
    setU32(block + BLOCK_STARTED, 1);
    setU32(block + BLOCK_FLAGS, flags);
    setU32(block + BLOCK_PASSES, passes);
    if (saved !== 0)
    {
        callStd(u32(u32(saved) + CAPTURE * 4), saved);
    }
    return 0;
}

/**
 * HRESULT End()
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function End({ u32, setU32, callStd, host }, self){
    const block = u32(self + 4);
    if (block === 0)
    {
        return host();
    }
    if (u32(block + BLOCK_STARTED) === 0)
    {
        return 0;
    }
    setU32(block + BLOCK_STARTED, 0);
    setU32(block + BLOCK_COMMIT, 0);
    setU32(block + BLOCK_PASSES, 0);
    const flags = u32(block + BLOCK_FLAGS);
    const technique = u32(block + BLOCK_TECHNIQUE);
    if ((flags & DONOTSAVESTATE) !== 0 || technique === 0)
    {
        return 0;
    }
    const saved = u32(technique + TECHNIQUE_SAVED + (flags & KEEPS) * 2);
    if (saved !== 0)
    {
        callStd(u32(u32(saved) + APPLY * 4), saved);
    }
    return 0;
}

/**
 * HRESULT SetTechnique(D3DXHANDLE hTechnique)
 *
 * The techniques are a count, then each one's handle and record; a handle
 * not among them is the host's to refuse.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} handle
 * @returns {u32}
 */
export function SetTechnique({ u32, setU32, host }, self, handle){
    const block = u32(self + 4);
    if (block === 0 || handle === 0)
    {
        return host();
    }
    const techniques = u32(block + BLOCK_TECHNIQUES);
    if (techniques === 0)
    {
        return host();
    }
    const count = u32(techniques);
    /** @type {u32} */
    let found = 0;
    for (let i = 0; i < (count | 0); i++)
    {
        if (u32(techniques + 4 + i * 8) === handle)
        {
            found = u32(techniques + 8 + i * 8);
        }
    }
    if (found === 0)
    {
        return host();
    }
    setU32(block + BLOCK_TECHNIQUE, found);
    if (u32(block + BLOCK_STARTED) !== 0)
    {
        setU32(block + BLOCK_PASSES, u32(found + TECHNIQUE_PASSES));
    }
    return 0;
}

/**
 * D3DXHANDLE GetTechnique(UINT Index)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} index
 * @returns {u32}
 */
export function GetTechnique({ u32, host }, self, index){
    const block = u32(self + 4);
    if (block === 0)
    {
        return host();
    }
    const techniques = u32(block + BLOCK_TECHNIQUES);
    if (techniques === 0)
    {
        return host();
    }
    return index < u32(techniques) ? u32(techniques + 4 + index * 8) : 0;
}

/**
 * Sets a pass's states from its table: every entry when `all`, else those
 * whose parameter changed since the pass was last applied; then dates it.
 * The last setter's answer that was not D3D_OK is the answer.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} block @param {u32} table @param {u32} all
 * @returns {u32}
 */
export function Walk({ u32, setU32, f32, setF32, callStd }, block, table, all){
    const applied = u32(u32(table + 4));
    const triggers = u32(table + 16);
    const device = u32(table);
    const scratch = u32(table + 12);
    const clock = u32(block + BLOCK_CLOCK);
    const now = u32(clock);
    setU32(clock, (now + 1) | 0);
    let answer = 0;
    let at = (table + HEADER + triggers * 4 + u32(table + STALE) * 8) >>> 0;
    const end = (at + u32(table + 8) * ENTRY) >>> 0;
    while (at < end)
    {
        if (all !== 0 || u32(u32(at + 4)) > applied)
        {
            const kind = u32(at);
            const fn = u32(u32(device) + u32(at + 8) * 4);
            const data = u32(at + 20);
            if (kind <= 6)
            {
                // Constants: each unit a word of the parameter (the map at `data`), or
                // zero, in the register's type as the host converts it.
                const units = u32(data);
                const words = u32(data + 4);
                for (let i = 0; i < (units | 0); i++)
                {
                    const from = u32(data + 8 + i * 4) | 0;
                    const at4 = (scratch + i * 4) >>> 0;
                    const word = from < 0 ? 0 : u32(words + from * 4);
                    if (from >= 0 && kind === 4)
                    {
                        setF32(at4, +(word | 0));
                    }
                    else if (from >= 0 && kind === 6)
                    {
                        setU32(at4, Math.trunc(f32(words + from * 4)) | 0);
                    }
                    else
                    {
                        setU32(at4, from < 0 ? 0 : kind === 2 ? (word !== 0 ? 1 : 0)
                            : kind === 3 ? ((word & 0x7fffffff) !== 0 ? 1 : 0)
                                : kind === 5 ? (word !== 0 ? 0x3f800000 : 0) : word);
                    }
                }
                const result = callStd(fn, device, u32(at + 12), scratch, u32(at + 16));
                if (result !== 0)
                {
                    answer = result;
                }
            }
            else
            {
                // A state: the parameter's word, or an expression that moves the
                // parameter -- through a float register, then the state's own
                // type, as the host's.
                const mode = u32(at + 24);
                const word = u32(data);
                const x = kind === 9 ? Math.fround(f32(data))
                    : Math.fround((mode & 2) !== 0 ? (word !== 0 ? 1 : 0) : +(word | 0));
                const value = kind === 7 ? word | 0
                    : (mode & 1) !== 0 ? (x !== 0 ? 1 : 0) : Math.trunc(x) | 0;
                const arity = u32(at + 28);
                const result = arity === 1 ? callStd(fn, device, value)
                    : arity === 2 ? callStd(fn, device, u32(at + 12), value)
                        : callStd(fn, device, u32(at + 12), u32(at + 16), value);
                if (result !== 0)
                {
                    answer = result;
                }
            }
        }
        at = (at + ENTRY) >>> 0;
    }
    setU32(u32(table + 4), now);
    return answer >>> 0;
}

/**
 * Works an expression's cell out again (`CELL`, `EXPRESSION` in `effect.js`):
 * its inputs read out of their parameters as the host reads them -- a float,
 * an int or a bool, each a float register's component -- its instructions run
 * a component at a time in doubles, each result stored as a float, and the
 * first output made the state's word and dated, as the host's preshader
 * (`preshader.js`) and `valueOf` do. The host leaves a program only for what
 * this runs exactly: no relative register, no transcendental of the x87's
 * range, one output; under a double control word the x87 rounds as
 * JavaScript does.
 *
 * @guestCode cdecl
 * @param {Evaluating} guest @param {u32} cell @param {u32} clock
 */
export function Evaluate({ u32, i32, f32, f64, setU32, setF32, setF64, controlWord,
    setControlWord }, cell, clock)
{
    const program = u32(cell + CELL_PROGRAM);
    const inputs = u32(program);
    const count = u32(program + 4);
    const registers = u32(program + 8);
    const slots = u32(program + 12);
    const saved = controlWord();
    setControlWord(DOUBLES);
    // A register no input or instruction wrote reads as zero.
    for (let slot = u32(program + 16) | 0; slot < (slots | 0); slot++)
    {
        setF64(registers + slot * 8, 0);
    }
    let at = (program + EXPRESSION_INPUT) >>> 0;
    for (let i = 0; i < (inputs | 0); i++)
    {
        const data = u32(at);
        const type = u32(at + 4);
        const words = u32(at + 8);
        const into = (registers + u32(at + 12) * 8) >>> 0;
        const step = (u32(at + 16) * 8) >>> 0;
        for (let c = 0; c < (words | 0); c++)
        {
            /** @type {f64} */
            let v = 0;
            if (type === 0)
            {
                v = f32(data + c * 4);
            }
            else if (type === 1)
            {
                v = +i32(data + c * 4);
            }
            else if (u32(data + c * 4) !== 0)
            {
                v = +1;
            }
            setF64((into + Math.imul(c, step)) >>> 0, Math.fround(v));
        }
        at = (at + INPUT_SIZE) >>> 0;
    }
    for (let k = 0; k < (count | 0); k++)
    {
        const op = u32(at);
        const components = u32(at + 8);
        const scalar = u32(at + 12);
        const first = (registers + u32(at + 16) * 8) >>> 0;
        const second = (registers + u32(at + 20) * 8) >>> 0;
        const third = (registers + u32(at + 24) * 8) >>> 0;
        const out = (registers + u32(at + 28) * 8) >>> 0;
        if (op === 1280)
        {
            // A dot product of the components, into the first.
            /** @type {f64} */
            let sum = 0;
            for (let j = 0; j < (components | 0); j++)
            {
                sum = sum + f64(scalar !== 0 ? first : (first + j * 8) >>> 0) * f64(second + j * 8);
            }
            setF64(out, Math.fround(sum));
        }
        else
        {
            for (let j = 0; j < (components | 0); j++)
            {
                const a = f64(scalar !== 0 ? first : (first + j * 8) >>> 0);
                const b = f64(second + j * 8);
                /** @type {f64} */
                let v = a;
                if (op === 257)
                {
                    v = -a;
                }
                else if (op === 259)
                {
                    v = 1 / a;
                }
                else if (op === 260)
                {
                    v = a - Math.floor(a);
                }
                else if (op === 262)
                {
                    v = a === 0 ? +0 : Math.log2(Math.abs(a));
                }
                else if (op === 263)
                {
                    v = 1 / Math.sqrt(Math.abs(a));
                }
                else if (op === 268)
                {
                    v = Math.atan(a);
                }
                else if (op === 512)
                {
                    // Math.min: NaN either way, and of two zeros the negative.
                    v = Number.isNaN(a) || Number.isNaN(b) ? a + b : a < b ? a : b < a ? b
                        : a === 0 && 1 / a < 0 ? a : b;
                }
                else if (op === 513)
                {
                    v = Number.isNaN(a) || Number.isNaN(b) ? a + b : a > b ? a : b > a ? b
                        : a === 0 && 1 / a > 0 ? a : b;
                }
                else if (op === 514)
                {
                    v = +(a < b ? 1 : 0);
                }
                else if (op === 515)
                {
                    v = +(a >= b ? 1 : 0);
                }
                else if (op === 516)
                {
                    v = a + b;
                }
                else if (op === 517)
                {
                    v = a * b;
                }
                else if (op === 518)
                {
                    v = Math.atan2(a, b);
                }
                else if (op === 520)
                {
                    v = +0;
                }
                else if (op === 768)
                {
                    v = a >= 0 ? b : f64(third + j * 8);
                }
                setF64(out + j * 8, Math.fround(v));
            }
        }
        at = (at + INSTRUCTION_SIZE) >>> 0;
    }
    // The first output as the state takes it (`valueOf`, `shaped`).
    const x = f64(registers + u32(program + 20) * 8);
    const mode = u32(program + 24);
    if (mode === 0)
    {
        setF32(cell, x);
    }
    else if (mode === 1)
    {
        setU32(cell, x !== 0 ? 0x3f800000 : 0);
    }
    else if (mode === 2)
    {
        setF32(cell, +(x | 0));
    }
    else if (mode === 3)
    {
        setU32(cell, x !== 0 ? 1 : 0);
    }
    else if (mode === 4)
    {
        setU32(cell, x | 0);
    }
    else
    {
        setU32(cell, Math.fround(x) >>> 0);
    }
    setU32(cell + CELL_DATE, (u32(clock) - 1) | 0);
    setControlWord(saved);
}
