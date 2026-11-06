/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IDirect3DShaderValidator9, which Direct3DShaderValidatorCreate9 hands out:
 * a shader assembler drives a token stream through it, Begin, an
 * Instruction per instruction, End, and hears of what is wrong through the
 * callback Begin named.
 *
 * What is judged is what Windows is known to answer (Wine's d3d9
 * test_shader_validator): an instruction before the version token, a Begin
 * while a validation is open, and an input register past the version's
 * last, declared or read. An instruction found wrong still answers S_OK,
 * and End then E_FAIL; a stream with no version is no shader, and its End
 * fails and leaves the validation open. Anything else passes: the device's
 * own create judges a shader in full (`validateShader`).
 *
 * The callback is the program's: HRESULT WINAPI callback(const char *file,
 * int line, DWORD_PTR, DWORD_PTR message_id, const char *message,
 * void *context).
 */

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;

/** The ids Windows reports these by. */
export const VALIDATOR_MESSAGE = Object.freeze({
    /** Begin while a validation is open. */
    BEGUN: 0xeb,
    /** The first token is no version token. */
    NO_VERSION: 0xef,
    /** And so the stream is no shader. */
    NOT_A_SHADER: 0xf0,
    /** A declaration of an input register past the last. */
    DECLARED_PAST: 0x12c,
    /** A read of an input register past the last. */
    READ_PAST: 0x167,
});

/** @type {Map<number, string>} */
const MESSAGES = new Map([
    [VALIDATOR_MESSAGE.BEGUN, 'Begin called while a validation is open.'],
    [VALIDATOR_MESSAGE.NO_VERSION, 'The first token is not a version token.'],
    [VALIDATOR_MESSAGE.NOT_A_SHADER, 'The token stream is not a shader.'],
    [VALIDATOR_MESSAGE.DECLARED_PAST, 'An input register past the last is declared.'],
    [VALIDATOR_MESSAGE.READ_PAST, 'An input register past the last is read.'],
]);

const END_TOKEN = 0x0000ffff;
const D3DSIO_DCL = 0x1f;
const D3DSIO_COMMENT = 0xfffe;
const D3DSPR_INPUT = 1;
/** A parameter's relative-addressing bit: a token of the address follows (version 2 on). */
const RELATIVE = 0x2000;

/**
 * How many input registers a version has: sixteen for a vertex shader, ten
 * for ps_3_0, the two colours before it.
 *
 * @param {number} version
 */
const inputsOf = version=>{
    const pixel = (version >>> 16) === 0xffff;
    if (!pixel)
    {
        return 16;
    }
    return ((version >>> 8) & 0xff) >= 3 ? 10 : 2;
};

/** @param {number} token */
const registerType = token=>((token >>> 28) & 7) | ((token >>> 8) & 0x18);

/**
 * @param {Object} deps
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *           writeMemory: (address: number, bytes: Uint8Array) => void }} deps.memory
 * @param {(call: { entry: number, args: number[], thread?: any })
 *     => Promise<number>} [deps.callGuest]
 * @param {() => any} [deps.currentThread]
 * @param {(bytes: number) => number} [deps.allocate]  Guest memory for a message, kept.
 */
export function createShaderValidator({ memory, callGuest, currentThread, allocate }){
    /** @type {Map<number, number>} */
    const texts = new Map();
    /** @param {number} id */
    const textOf = id=>{
        let at = texts.get(id);
        if (at === undefined)
        {
            const text = MESSAGES.get(id) ?? '';
            at = allocate?.(text.length + 1) ?? 0;
            if (at !== 0)
            {
                memory.writeMemory(at, Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0)));
            }
            texts.set(id, at);
        }
        return at;
    };
    /** @param {number} address @param {number} count */
    const words = (address, count)=>{
        const bytes = memory.readMemory(address >>> 0, count * 4);
        return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 4));
    };

    let open = false;
    let version = 0;
    let failed = false;
    let callback = 0;
    let context = 0;

    /**
     * Tells the program, one message after another, and answers `hr` once
     * it has heard them; at once when there is nothing to tell or no one to.
     *
     * @param {number} to  The callback.
     * @param {number} about  Its context.
     * @param {[number, number, number][]} messages  File, line and id each.
     * @param {number} hr
     * @returns {number | Promise<number>}
     */
    const tell = (to, about, messages, hr)=>{
        if (messages.length === 0 || (to >>> 0) === 0 || !callGuest)
        {
            return hr;
        }
        const thread = currentThread?.();
        return messages.reduce((/** @type {Promise<unknown>} */ before, [file, line, id])=>
            before.then(()=>callGuest({ entry: to >>> 0,
                args: [file >>> 0, line >>> 0, 0, id, textOf(id), about >>> 0], thread })),
        Promise.resolve()).then(()=>hr);
    };

    /**
     * The input registers an instruction names, and whether each is the one
     * it declares.
     *
     * @param {Uint32Array} tokens
     * @returns {{ register: number, declared: boolean }[]}
     */
    const inputsNamed = tokens=>{
        const opcode = tokens[0] & 0xffff;
        /** @type {{ register: number, declared: boolean }[]} */
        const named = [];
        if (opcode === D3DSIO_DCL)
        {
            if (tokens.length >= 3 && registerType(tokens[2]) === D3DSPR_INPUT)
            {
                named.push({ register: tokens[2] & 0x7ff, declared: true });
            }
            return named;
        }
        // The destination, then the sources, each with its address token.
        for (let at = 1; at < tokens.length; at++)
        {
            const token = tokens[at];
            if (at > 1 && registerType(token) === D3DSPR_INPUT)
            {
                named.push({ register: token & 0x7ff, declared: false });
            }
            if ((token & RELATIVE) !== 0 && (version & 0xff00) >= 0x0200)
            {
                at++;
            }
        }
        return named;
    };

    return {
        /**
         * HRESULT Begin(shader_validator_cb callback, void *context, DWORD_PTR)
         *
         * @param {number[]} args
         */
        Begin: ([to, about])=>{
            if (open)
            {
                return tell(to, about, [[0, 0, VALIDATOR_MESSAGE.BEGUN]], E_FAIL);
            }
            open = true;
            version = 0;
            failed = false;
            callback = to >>> 0;
            context = about >>> 0;
            return S_OK;
        },

        /**
         * HRESULT Instruction(const char *file, int line, const DWORD *tokens,
         *                     unsigned int count)
         *
         * @param {number[]} args
         */
        Instruction: ([file, line, at, count])=>{
            if ((count >>> 0) === 0 || (at >>> 0) === 0 || !open)
            {
                return E_FAIL;
            }
            const tokens = words(at, count >>> 0);
            if (version === 0)
            {
                const kind = tokens[0] >>> 16;
                if (kind !== 0xfffe && kind !== 0xffff)
                {
                    failed = true;
                    return tell(callback, context, [[0, -1, VALIDATOR_MESSAGE.NO_VERSION],
                        [0, 0, VALIDATOR_MESSAGE.NOT_A_SHADER]], E_FAIL);
                }
                version = tokens[0];
                return S_OK;
            }
            if (tokens[0] === END_TOKEN || (tokens[0] & 0xffff) === D3DSIO_COMMENT)
            {
                return S_OK;
            }
            const last = inputsOf(version);
            /** @type {[number, number, number][]} */
            const messages = inputsNamed(tokens)
                .filter(({ register })=>register >= last)
                .map(({ declared })=>[file, line, declared
                    ? VALIDATOR_MESSAGE.DECLARED_PAST : VALIDATOR_MESSAGE.READ_PAST]);
            failed ||= messages.length > 0;
            return tell(callback, context, messages, S_OK);
        },

        /** HRESULT End(void): a stream with no version leaves the validation open. */
        End: ()=>{
            if (!open || version === 0)
            {
                return E_FAIL;
            }
            open = false;
            return failed ? E_FAIL : S_OK;
        },
    };
}
