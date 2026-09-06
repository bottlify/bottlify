/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { assembleModules } from './core.js';

/**
 * createApp — the consumer-facing entry point: run a Win32 application.
 *
 * Everything below it is the module graph; this is the one place that wires the
 * cross-cutting step the graph deliberately does not express. An executable's
 * imports have to become guest addresses that trap into win32, but win32 does
 * not know how a guest call reaches the host and cpu does not know what win32
 * implements. Neither should. Assembling a process is what knows both.
 */

/**
 * @typedef {Object} AppOptions
 * @property {Uint8Array} executable      The program to run.
 * @property {Object} v86                 Emulator artifacts.
 * @property {string} v86.moduleUrl
 * @property {ArrayBuffer} v86.wasmBytes
 * @property {number} [stackSize]
 */

/**
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    /** @type {((handle: number, text: string) => void)[]} */
    const sinks = [];

    const core = await assembleModules({
        win32: {
            /** @param {number} handle @param {string} text */
            onOutput: (handle, text)=>{
                for (const sink of sinks)
                {
                    sink(handle, text);
                }
            },
        },
    });

    const cpu = core.api('cpu');
    const memory = core.api('memory');
    const loader = core.api('loader');
    const win32 = core.api('win32');

    await cpu.boot(options.v86);

    const { entryVector, initialStack, thunkBase } = cpu.layout;
    const stackSize = options.stackSize ?? 0x10000;

    memory.register({
        name: 'entry-vector', base: entryVector, size: 4,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'stack', base: initialStack - stackSize, size: stackSize,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE,
    });

    // Binding imports registers stubs, so the table's size is only known here.
    const image = loader.load(options.executable, {
        resolveImport: (/** @type {string} */ dll, /** @type {string | null} */ name)=>{
            const fn = win32.resolve(name ?? '');
            if (!fn)
            {
                return null;
            }
            return cpu.registerTrap(`${dll}!${name}`, fn.argBytes, fn.handler);
        },
    });

    const stubs = cpu.thunkImage();
    memory.register({
        name: 'thunks', base: thunkBase, size: stubs.length,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Written once; from here a write into the stubs would be corruption.
    memory.protect('thunks', memory.Access.READ_EXECUTE);

    memory.writeU32(entryVector, image.entryPoint);

    /** @type {((code: number) => void) | null} */
    let notifyExit = null;
    let finished = false;

    cpu.onTrap((/** @type {number} */ id)=>{
        const entry = cpu.lookupTrap(id);
        if (!entry)
        {
            throw new Error(`trap ${id} has no handler`);
        }

        // At the OUT, ESP still points at the return address the CALL pushed, so
        // argument N sits just above it.
        const esp = cpu.readReg32('esp');
        const args = [];
        for (let i = 0; i < entry.argBytes / 4; i++)
        {
            args.push(memory.readU32(esp + 4 + i * 4) | 0);
        }

        cpu.writeReg32('eax', entry.handler(args) >>> 0);

        const code = win32.exitCode();
        if (code !== null && !finished)
        {
            // The stub still has a `ret` to execute. Send it to the park loop
            // rather than back into a caller that no longer expects it, and stop
            // the machine outside this callback -- stopping here would leave that
            // `ret` to run anyway.
            finished = true;
            memory.writeU32(esp, cpu.parkAddress());
            setTimeout(()=>{
                cpu.stop();
                if (notifyExit)
                {
                    notifyExit(code);
                }
            }, 0);
        }
    });

    return {
        /** Where the program was mapped and where it starts. */
        image,

        /**
         * Runs until the program exits.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.timeoutMs]
         * @returns {Promise<number>} the guest's exit code
         */
        run({ timeoutMs = 30000 } = {}){
            return new Promise((resolve, reject)=>{
                const deadline = setTimeout(()=>{
                    cpu.stop();
                    reject(new Error(`application did not exit within ${timeoutMs}ms`));
                }, timeoutMs);
                notifyExit = code=>{
                    clearTimeout(deadline);
                    resolve(code);
                };
                cpu.run();
            });
        },

        /** Halts execution without ending the process; `resume` picks it back up. */
        pause: ()=>cpu.stop(),
        resume: ()=>cpu.run(),
        stop: ()=>cpu.stop(),

        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            sinks.push(sink);
        },
        /** @param {(handle: number, text: string) => void} sink */
        detachLog(sink){
            const at = sinks.indexOf(sink);
            if (at !== -1)
            {
                sinks.splice(at, 1);
            }
        },

        exitCode: ()=>win32.exitCode(),
        diagnostics: ()=>core.diagnostics(),
        dispose: ()=>core.dispose(),
    };
}
