/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The wasm build of this project's own zstd decoder (`scripts/zstd/zstd.c`,
 * built to `vendor/zstd.wasm` by `build-zstd.mjs`), wrapped as the same
 * synchronous call `zstd.js` offers: `decompress(packed, expectedLength)`.
 *
 * The module is instantiated once, asynchronously (a browser refuses a large
 * synchronous compile on its main thread); every decode after that is a
 * synchronous call, which a guest file read needs. The module's memory is
 * scratch: the packed bytes are copied in after the module's own data
 * (`__heap_base`), the output follows them, and the result is copied out, so
 * nothing of the caller's is shared with the module.
 *
 * The errors are `zstd.js`'s, word for word, so a caller sees one decoder.
 */

const ERRORS = Object.freeze({
    [-1]: 'zstd: corrupt frame',
    [-2]: 'zstd: unsupported feature (a dictionary, a window past 128 MiB or a reserved block)',
    [-3]: 'zstd: frame ended before it was supposed to',
    [-4]: 'zstd: output does not fit',
});
const PAGE = 65536;

/**
 * @typedef {Object} ZstdWasm
 * @property {(packed: Uint8Array, expectedLength: number) => Uint8Array} decompress
 * @property {number} version
 */

/**
 * Instantiates the decoder from its bytes.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {Promise<ZstdWasm>}
 */
export async function loadZstdWasm(bytes){
    const result = await WebAssembly.instantiate(/** @type {BufferSource} */ (bytes), {});
    const { instance } = /** @type {WebAssembly.WebAssemblyInstantiatedSource} */ (result);
    const exports = /** @type {{ memory: WebAssembly.Memory, __heap_base: WebAssembly.Global,
     *     zstd_decompress: (i: number, n: number, o: number, c: number) => number,
     *     zstd_version: () => number }} */ (/** @type {unknown} */ (instance.exports));
    const version = exports.zstd_version();
    if (version !== 1)
    {
        throw new Error(`zstd: the wasm decoder speaks interface ${version}, this wrapper 1`);
    }
    const { memory } = exports;
    // The scratch area starts past the module's own data, 16-aligned.
    const base = (Number(exports.__heap_base.value) + 15) & ~15;

    /** @param {number} total the scratch bytes wanted past `base` */
    const ensure = total=>{
        const need = base + total;
        if (memory.buffer.byteLength < need)
        {
            memory.grow(Math.ceil((need - memory.buffer.byteLength) / PAGE));
        }
    };

    /**
     * @param {Uint8Array} packed
     * @param {number} expectedLength  0 when the frame's own size is trusted
     * @returns {Uint8Array}
     */
    const decompress = (packed, expectedLength)=>{
        const inAt = base;
        const outAt = (base + packed.length + 15) & ~15;
        // Unknown output: start from a guess and double on the decoder's word.
        let capacity = expectedLength > 0
            ? expectedLength
            : Math.max(PAGE, packed.length * 8);
        for (;;)
        {
            // The decoder's copies may run OUT_SLACK (32) bytes past the capacity.
            ensure(outAt - base + capacity + 32);
            new Uint8Array(memory.buffer, inAt, packed.length).set(packed);
            const answer = exports.zstd_decompress(inAt, packed.length, outAt, capacity);
            if (answer === -4 && expectedLength === 0)
            {
                capacity *= 2;
                continue;
            }
            if (answer < 0)
            {
                throw new Error(ERRORS[/** @type {-1 | -2 | -3 | -4} */ (answer)]
                    ?? `zstd: the wasm decoder answered ${answer}`);
            }
            if (expectedLength > 0 && answer < expectedLength)
            {
                throw new Error(ERRORS[-3]);
            }
            const length = expectedLength > 0 ? expectedLength : answer;
            return new Uint8Array(memory.buffer, outAt, length).slice();
        }
    };
    return { decompress, version };
}
