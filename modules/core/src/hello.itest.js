/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

/**
 * Phase 1 acceptance: the fixture executable runs under Bottlify and produces
 * the same output real Windows produces from the same file.
 *
 * This wires the layers' internals together by hand. That is the honest state
 * of Phase 1 — the module-level surface still has to be built on top — but the
 * mechanism it proves is the real one: cold boot, PE mapping, import binding,
 * guest→host traps, kernel32, exit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from './layers/cpu/internal/v86-host.js';
import { createThunkTable, STUB_SIZE } from './layers/cpu/internal/thunks.js';
import { buildImage } from './layers/loader/internal/image.js';
import { createConsoleFunctions } from './layers/win32/kernel32/console.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/hello.exe', import.meta.url);

const TRAP_PORT = 0xb077;
const ENTRY_VECTOR = 0x7000;
const THUNK_BASE = 0x200000;
const INITIAL_STACK = 0x300000;

/** What the same binary prints when Windows runs it. */
const EXPECTED_OUTPUT = 'Hello from Bottlify\r\n';

/**
 * Runs the fixture to completion and reports what the guest did.
 */
async function runFixture(){
    const [wasm, exe] = await Promise.all([readFile(new URL('v86.wasm', PREBUILT)), readFile(FIXTURE)]);

    const host = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: TRAP_PORT,
        entryVector: ENTRY_VECTOR,
        initialStack: INITIAL_STACK,
    });

    /** @type {string[]} */
    const output = [];
    /** @type {number | null} */
    let exitCode = null;
    let exiting = false;

    const functions = createConsoleFunctions({
        readMemory: (address, length)=>host.readPhysical(address, length),
        writeMemory: (address, bytes)=>host.writePhysical(address, bytes),
        write: (_handle, text)=>output.push(text),
        // kernel32 says the process is over; how the guest is brought to a halt is
        // the cpu layer's business, handled in the trap dispatcher below.
        exit: code=>{
            exitCode = code;
            exiting = true;
        },
    });

    const thunks = createThunkTable({ base: THUNK_BASE, port: TRAP_PORT });
    /** @type {string[]} */
    const called = [];

    const image = buildImage(new Uint8Array(exe), {
        resolveImport: (dll, name)=>{
            const fn = functions[/** @type {keyof typeof functions} */ (name ?? '')];
            if (!fn) return null;
            return thunks.register(`${dll}!${name}`, fn.argBytes, fn.handler);
        },
    });
    assert.deepEqual(image.unresolved, [], 'every import the fixture needs is implemented');

    host.writePhysical(image.base, image.bytes);
    host.writePhysical(THUNK_BASE, thunks.image());
    host.writePhysical(ENTRY_VECTOR, new Uint8Array([
        image.entryPoint & 0xff,
        image.entryPoint >>> 8 & 0xff,
        image.entryPoint >>> 16 & 0xff,
        image.entryPoint >>> 24 & 0xff,
    ]));

    host.onTrap(trapId=>{
        const entry = thunks.lookup(trapId);
        if (!entry) throw new Error(`trap ${trapId} has no handler`);
        called.push(entry.name);

        // At the OUT, ESP still points at the return address the CALL pushed, so
        // argument N sits just above it.
        const esp = host.readReg32('esp');
        const argCount = entry.argBytes / 4;
        const args = [];
        for (let i = 0; i < argCount; i++){
            const raw = host.readPhysical(esp + 4 + i * 4, 4);
            args.push(raw[0] | raw[1] << 8 | raw[2] << 16 | raw[3] << 24 | 0);
        }

        host.writeReg32('eax', entry.handler(args) >>> 0);

        if (exiting){
            // The stub still has a `ret` to execute. Send it to the park loop instead
            // of back into the caller, then stop the machine from outside this
            // callback — stopping here would leave that `ret` to run regardless.
            const park = thunks.parkAddress;
            host.writePhysical(esp, new Uint8Array([
                park & 0xff, park >>> 8 & 0xff, park >>> 16 & 0xff, park >>> 24 & 0xff,
            ]));
            setTimeout(()=>host.stop(), 0);
        }
    });

    host.run();

    await new Promise((resolve, reject)=>{
        const deadline = setTimeout(()=>{
            host.stop();
            reject(new Error(`guest never exited; output so far: ${JSON.stringify(output.join(''))}`));
        }, 8000);
        const poll = setInterval(()=>{
            if (exitCode !== null){
                clearTimeout(deadline);
                clearInterval(poll);
                resolve(undefined);
            }
        }, 20);
    });

    return { output: output.join(''), exitCode, called, instructions: host.instructionCount() };
}

test('hello.exe prints what it prints on Windows, then exits cleanly', async()=>{
    const result = await runFixture();

    assert.equal(result.output, EXPECTED_OUTPUT, 'same bytes real Windows writes to stdout');
    assert.equal(result.exitCode, 0, "the guest's own exit code");
});

test('the guest reached kernel32 through its import table, in order', async()=>{
    const result = await runFixture();
    assert.deepEqual(result.called, [
        'KERNEL32.dll!GetStdHandle',
        'KERNEL32.dll!WriteFile',
        'KERNEL32.dll!ExitProcess',
    ]);
});

test('thunk stubs return to the caller with the stack intact', async()=>{
    // If a stub popped the wrong number of argument bytes, execution after
    // GetStdHandle would resume at a bogus address and the run would never reach
    // ExitProcess — so completing at all is the assertion here, and the low
    // instruction count shows it went straight there rather than wandering.
    const result = await runFixture();
    assert.equal(result.exitCode, 0);
    assert.ok(result.instructions < 200, `no detour before exit (${result.instructions} instructions)`);
    assert.equal(STUB_SIZE, 16);
});
