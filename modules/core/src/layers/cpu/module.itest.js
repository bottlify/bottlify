/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Integration test: what the layer publishes about a real machine.
 *
 * A frame's account of the interpreter can only be checked against an emulator
 * that actually has one, so this needs the prebuilt vendor artifacts -- run
 * `npm run fetch:v86`, then `npm run test:integration`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpuModule } from './module.js';
import { ROM_BASE } from './internal/boot-rom.js';
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

const PREBUILT = new URL('../../../vendor/prebuilt/', import.meta.url);
const GUEST_CODE = 0x8000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * The layer over a real emulator, with a guest that runs forever from `at`.
 *
 * @param {Uint8Array} code @param {number} at @param {any} [config]
 */
async function booted(code, at, config = {}){
    const metrics = createMetrics({ shared: false });
    /** @type {string[]} */
    const words = [];
    const api = await cpuModule.create({ engine: 'emulator', ...config }, /** @type {any} */ ({
        requireApi: ()=>({
            metrics,
            /** @param {string} text */
            intern: text=>{
                const found = words.indexOf(text);
                return found >= 0 ? found : words.push(text) - 1;
            },
        }),
        provide: ()=>{},
    }));
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    await api.boot({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    api.writePhysical(at, code);
    api.writePhysical(0x7000, new Uint8Array(u32(at)));
    // The machine is left standing on the ROM's jump into guest code, so the
    // first slice is the one that takes it there. Spent here and its figures
    // dropped, so what follows is measured on guest code alone.
    api.runSlice(100);
    metrics.sample();
    const counters = ()=>readTable(metrics.describe().cpu.counters).row(0);
    return { api, metrics, counters };
}

test('under cork the jit counters say -1, not a dead compiler', async()=>{
    // Cork has no emulator compiler: the `jit.*` columns stay in the table
    // (a caller reads the same schema on every engine) but report -1, so a
    // zero is never mistaken for a compiler that compiled nothing.
    const metrics = createMetrics({ shared: false });
    const api = await cpuModule.create({
        engine: 'cork',
        engineUrl: new URL('../../../../cork/src/index.js', import.meta.url).href,
    }, /** @type {any} */ ({
        requireApi: ()=>({ metrics, intern: ()=>-1 }), provide: ()=>{},
    }));
    await api.boot();
    api.writePhysical(GUEST_CODE, new Uint8Array([0xf4]));
    api.writePhysical(0x7000, new Uint8Array(u32(GUEST_CODE)));
    api.runSlice(100);
    metrics.sample();
    const row = readTable(metrics.describe().cpu.counters).row(0);
    assert.equal(row['jit.compiledSteps'], -1);
    assert.equal(row['jit.cache'], -1);
    assert.equal(/** @type {any} */ (cpuModule.diagnostics().metrics).jit, -1);
    await cpuModule.dispose();
});

test('a frame names where the interpreter ran, and starts again after it', async()=>{
    // A loop small enough to stay in one block: the interpreter runs it until
    // the page is hot enough to compile, which is exactly the stretch a stall
    // frame is made of.
    const { api, metrics, counters } = await booted(
        new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);

    // The first slices are the cold ones, and the whole point is that the
    // address they ran at is published rather than only their count.
    api.runSlice(20_000);
    metrics.sample();
    const cold = counters();
    assert.ok(cold['jit.interpretedSteps'] > 0,
        'a cold page is interpreted; without that this test proves nothing');
    assert.ok(cold.frameInterpreted > 0, 'the frame says how much of it was interpreted');
    // The loop is three bytes, and a slice stops on the bound wherever in it
    // that falls -- so the address names the loop rather than one instruction.
    assert.ok(cold.frameInterpretedAt >= GUEST_CODE && cold.frameInterpretedAt < GUEST_CODE + 3,
        `the heaviest interpreted slice began at 0x${cold.frameInterpretedAt.toString(16)},`
        + ` which is not the guest's loop`);

    // A frame in which no slice ran claims nothing, rather than repeating the
    // last frame's address -- which is what a figure that is not reset does.
    metrics.sample();
    const quiet = counters();
    assert.equal(quiet.frameInterpreted, 0);
    assert.equal(quiet.frameInterpretedAt, 0);
    assert.ok(quiet['jit.interpretedSteps'] >= cold['jit.interpretedSteps'],
        'the run total only grows; only the frame fields reset');

    // And the next frame with a slice in it names the code again.
    api.runSlice(20_000);
    metrics.sample();
    assert.ok(counters().frameInterpretedAt >= GUEST_CODE,
        'the account carries on after a frame that had nothing to say');

    api.stop();
    await cpuModule.dispose();
});

test('the account can be asked where the interpreter ran, exactly', async()=>{
    const { api } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);
    assert.equal(api.profile.available(), true,
        'the fork keeps the address account in a release build; without it there is nothing here');

    // Keeping the warm code is what makes this an interpreter account rather
    // than a whole-guest one: only code compiled from now on counts itself, so
    // what lands in the table is the interpreter's instructions, one per hit.
    const before = api.interpretedSteps();
    assert.equal(api.profile.start({ keepCode: true }), true);
    for (let i = 0; i < 10; i++)
    {
        api.runSlice(20_000);
    }
    const ran = api.interpretedSteps() - before;
    /** @type {{ entries: { address: number, instructions: number, hits: number }[],
     *     dropped: number } | null} */
    const account = api.profile.read();
    assert.ok(account, 'the account answers');
    const interpreted = account.entries.filter(one=>one.instructions === one.hits);
    assert.ok(interpreted.length > 0, 'the interpreted addresses are named');
    const weight = interpreted.reduce((total, one)=>total + one.instructions, 0);
    assert.ok(weight > ran / 2,
        `the account holds ${weight} of the ${ran} instructions the interpreter ran`);
    for (const one of interpreted)
    {
        assert.ok(one.address >= GUEST_CODE && one.address < GUEST_CODE + 3,
            `0x${one.address.toString(16)} is not in the guest's loop`);
    }
    api.profile.stop();

    api.stop();
    await cpuModule.dispose();
});

test('a slice that ends before its budget credits no sample to where it stopped', async()=>{
    // mov ecx, 50000; L: dec ecx; jnz L; hlt -- the slice ends early at the hlt,
    // which is where the guest asked to stop, not where it ran.
    const { api } = await booted(new Uint8Array([0xb9, 0x50, 0xc3, 0, 0, 0x49, 0x75, 0xfd, 0xf4]),
        GUEST_CODE);
    const retired = api.runSlice(10_000_000);
    assert.ok(retired > 50_000 && retired < 10_000_000, `the loop ran and halted: ${retired}`);
    const metrics = /** @type {any} */ (cpuModule.diagnostics().metrics ?? {});
    const halt = metrics.samples.top.find((/** @type {any} */ bucket)=>
        bucket.address <= GUEST_CODE + 8 && GUEST_CODE + 8 < bucket.address + 0x40);
    // The boot's own first slice, which ran its budget, may sit in the bucket.
    assert.ok((halt?.instructions ?? 0) < retired,
        `the hlt is not charged with the loop: ${JSON.stringify(halt)}`);
    api.stop();
    await cpuModule.dispose();
});

test('slices against a real emulator credit the address the guest ran at', async()=>{
    const { api } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);

    api.runSlice(20_000);
    // `diagnostics()` is the module's, not the instance's -- read through the
    // same door a real caller does.
    const status = cpuModule.diagnostics();
    assert.equal(status.status, 'ready');
    const metrics = /** @type {any} */ (status.metrics ?? {});
    assert.ok(metrics.samples.slices > 0, 'the slice that ran was credited');
    assert.ok(metrics.samples.top.length > 0);
    const [top] = metrics.samples.top;
    assert.ok(top.address >= GUEST_CODE - 0x40 && top.address < GUEST_CODE + 3,
        `the heaviest bucket is at 0x${top.address.toString(16)}, not the guest's loop`);
    assert.ok(top.instructions > 0);
    // No clock per slice: the sampler credits instructions only, and a reader
    // derives milliseconds from the guest phase (cpu.md, "Sampling").
    assert.equal(top.ms, undefined);

    api.stop();
    await cpuModule.dispose();
});

test('sampling: false leaves every slice uncredited', async()=>{
    const { api } = await booted(
        new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE, { sampling: false });

    api.runSlice(20_000);
    const status = cpuModule.diagnostics();
    const metrics = /** @type {any} */ (status.metrics ?? {});
    assert.equal(metrics.samples.slices, 0);
    assert.deepEqual(metrics.samples.top, []);

    api.stop();
    await cpuModule.dispose();
});

test('an exception the processor cannot deliver is a double fault, not a host overflow', async()=>{
    // Paging turned on over a page directory of zeroes: the next fetch page
    // faults, delivering that reads the interrupt table through the same
    // directory and faults again, and the emulator recurses until the host's
    // stack is gone. What a reader saw was a range error naming nothing.
    const { api } = await booted(new Uint8Array([
        0x0f, 0x20, 0xc0, //             mov eax, cr0
        0x0d, 0x00, 0x00, 0x00, 0x80, // or eax, 0x80000000
        0x0f, 0x22, 0xc0, //             mov cr0, eax
        0x90, 0x90, //                   nop nop
    ]), GUEST_CODE);

    assert.doesNotThrow(()=>api.runSlice(1000));
    const fault = api.fault();
    assert.ok(fault, 'the machine stopped on a fault');
    assert.equal(fault.vector, 8);
    assert.match(fault.text, /^double fault at 0x0000800[b-d]: a page fault at 0x[0-9a-f]{8}/,
        'named, at the instruction whose fault could not be delivered');
    assert.match(fault.text, /paging is on with cr3 0x0/);
    assert.equal(api.runSlice(1000), 0, 'and it stays stopped');

    api.stop();
    await cpuModule.dispose();
});

test('a guest that strays into the retired boot code is reported as an excursion', async()=>{
    // A return through a wrecked stack can land on the ROM's init, whose
    // `mov cr0, eax` then turns paging on with whatever EAX holds. The bytes
    // are retired after bring-up so the excursion is named at its first byte.
    const target = ROM_BASE + 0x19;
    const { api } = await booted(new Uint8Array([
        0xe9, ...u32(target - (GUEST_CODE + 5)), // jmp target
    ]), GUEST_CODE);

    api.runSlice(1000);
    const fault = api.fault();
    assert.ok(fault, 'the machine stopped on a fault');
    assert.equal(fault.vector, 3, 'the retired bytes are breakpoints');
    assert.match(fault.text, /^guest jumped into the boot ROM at 0x000f001a/);

    api.stop();
    await cpuModule.dispose();
});

test('a second instance in one realm boots on its own, never seeing the first one\'s emulator',
    async()=>{
        const { api: first } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);

        const metrics = createMetrics({ shared: false });
        const second = await cpuModule.create({ engine: 'emulator' }, /** @type {any} */ ({
            requireApi: ()=>({ metrics, intern: ()=>-1 }),
            provide: ()=>{},
        }));
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        // Before the fix this threw "cpu: already booted": the check read the
        // module's own `host`, which the first instance had already set,
        // rather than this instance's own -- still-null -- one.
        await second.boot({
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        });
        assert.equal(second.booted(), true);
        assert.equal(first.booted(), true, 'and the first instance is unaffected');

        second.stop();
        first.stop();
        await cpuModule.dispose();
    });

test('a disposed cpu answers as a never-booted one does, after a real boot', async()=>{
    const { api } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);
    assert.equal(api.booted(), true);

    await cpuModule.dispose();

    assert.equal(api.booted(), false);
    assert.equal(api.fault(), null);
    assert.throws(()=>api.readPhysical(0, 4),
        /cpu: boot\(\) must be called before the guest can run/);
    assert.throws(()=>api.runSlice(1),
        /cpu: boot\(\) must be called before the guest can run/);
});

test('hybrid with no translator runs a program exactly as the emulator does, to the instruction',
    async()=>{
        // A loop with a conditional exit and a memory write, so the count
        // depends on what the guest computed rather than on the slice bound
        // alone: mov ecx, 5000; L: dec ecx; mov [0x9000], ecx; jnz L; hlt.
        const program = new Uint8Array([
            0xb9, ...u32(5000),
            0x49,
            0x89, 0x0d, ...u32(0x9000),
            0x75, 0xf7,
            0xf4,
        ]);
        /** @param {any} config */
        const runToHalt = async config=>{
            const { api } = await booted(program, GUEST_CODE, config);
            const before = api.instructionCount();
            let retired = 0;
            for (let slice = 0; slice < 50; slice++)
            {
                const ran = api.runSlice(1000);
                retired += ran;
                if (ran === 0)
                {
                    break;
                }
            }
            const result = {
                retired, total: api.instructionCount() - before, eip: api.eip(),
                ecx: api.readReg32('ecx'), engine: cpuModule.diagnostics().metrics?.engine,
            };
            api.stop();
            await cpuModule.dispose();
            return result;
        };

        const emulator = await runToHalt({ engine: 'emulator' });
        const hybrid = await runToHalt({ engine: 'hybrid' });

        assert.equal(emulator.engine, 'emulator');
        assert.equal(hybrid.engine, 'hybrid');
        // 5000 iterations of three instructions, less the hundred `booted()`
        // already spent on the first slice.
        assert.ok(emulator.retired > 5000 * 3 - 200, `the loop ran (${emulator.retired})`);
        assert.equal(hybrid.retired, emulator.retired, 'slices retired the same count');
        assert.equal(hybrid.total, emulator.total, 'and the instruction counter agrees');
        assert.equal(hybrid.eip, emulator.eip, 'ending on the same instruction');
        assert.equal(hybrid.ecx, 0);
    });
