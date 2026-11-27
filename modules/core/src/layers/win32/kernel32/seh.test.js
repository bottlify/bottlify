/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSeh, RECORD, CONTEXT, Disposition, EFLAGS_AC, EFLAGS_DF, EFLAGS_TF, END_OF_CHAIN,
    EH_UNWINDING, SELECTORS, STATUS,
} from './seh.js';
import { floatImages, restoreFloatImages } from '../../cpu/internal/fpu-image.js';

const TEB = 0x8000;
const STACK = 0x40000;

/**
 * Guest memory, a thread block, and a record of what was called.
 *
 * @param {Object} [options]
 * @param {(entry: number, args: number[]) => number} [options.answer]
 */
function machine(options = {}){
    const bytes = new Uint8Array(0x80000);
    const view = new DataView(bytes.buffer);
    /** @type {{ entry: number, args: number[] }[]} */
    const called = [];
    /** The flags each call was told to start with, or undefined for none. */
    /** @type {(number | undefined)[]} */
    const startedWith = [];
    let registers = {
        eax: 0x11, ecx: 0x22, edx: 0x33, ebx: 0x44,
        esp: STACK, ebp: 0x55, esi: 0x66, edi: 0x77,
        eip: 0x401000, eflags: 0x202,
    };

    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeMemory: (at, value)=>bytes.set(value, at),
        // Everything inside the buffer is there; nothing outside is. A bounds
        // test and nothing else, because images are readable rather than
        // executable and asking for execute rejects a real handler.
        /** @param {number} at */
        isMapped: at=>at > 0 && at < bytes.length,
        teb: ()=>TEB,
        registers: ()=>({ ...registers }),
        // What the bridge does with such an answer once the caller resumes.
        /** @param {number} value @param {Record<string, number>} values */
        answerWith: (value, values)=>{
            registers = { ...registers, ...values };
            return value;
        },
        /**
         * @param {{ entry: number, args: number[], stackAtRest?: number,
         *     registers?: Record<string, number> }} call
         */
        callGuest: async call=>{
            called.push({ entry: call.entry, args: [...call.args] });
            startedWith.push(call.registers?.eflags);
            return options.answer
                ? options.answer(call.entry, call.args)
                : Disposition.CONTINUE_SEARCH;
        },
    };

    /** @param {number} at @param {number} value */
    const put = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const get = at=>view.getUint32(at, true);

    /**
     * Builds a chain of frames at ascending addresses, each naming a handler.
     *
     * @param {number[]} handlers
     */
    const registerFrames = handlers=>{
        const frames = handlers.map((handler, index)=>{
            const frame = 0x20000 + index * 0x100;
            put(frame + 4, handler);
            return frame;
        });
        frames.forEach((frame, index)=>
            put(frame, index + 1 < frames.length ? frames[index + 1] : END_OF_CHAIN));
        put(TEB, frames.length > 0 ? frames[0] : END_OF_CHAIN);
        return frames;
    };

    return {
        host, called, startedWith, put, get, registerFrames,
        seh: createSeh(host),
        registers: ()=>registers,
    };
}

test('the record is eighty bytes, and the parameters are where a handler reads them', ()=>{
    // Sharing the word after the record with its last parameter is invisible
    // while the parameter count is zero, and lethal to a handler that copies
    // the whole structure.
    assert.equal(RECORD.SIZE, 0x50);
    assert.equal(RECORD.INFORMATION, 0x14, 'fifteen parameters follow four dwords and a count');
    assert.equal(RECORD.INFORMATION + 15 * 4, RECORD.SIZE, 'and they fill it exactly');
});

test('the guest context is the layout a handler was compiled against', ()=>{
    // Not the shape the engine keeps. Every one of these is a translation,
    // and a wrong offset hands a handler a plausible number from the next
    // field along.
    assert.equal(CONTEXT.SIZE, 0x2cc);
    assert.deepEqual(
        [CONTEXT.EDI, CONTEXT.ESI, CONTEXT.EBX, CONTEXT.EDX, CONTEXT.ECX, CONTEXT.EAX],
        [0x9c, 0xa0, 0xa4, 0xa8, 0xac, 0xb0]);
    assert.deepEqual([CONTEXT.EBP, CONTEXT.EIP, CONTEXT.EFLAGS, CONTEXT.ESP],
        [0xb4, 0xb8, 0xc0, 0xc4]);
});

test('every frame is offered the exception, in chain order', async()=>{
    const m = machine();
    m.registerFrames([0x51000, 0x52000, 0x53000]);

    await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000, 0x53000],
        'a frame skipped lands the exception in one that should never have seen it');
});

test('a handler is handed the record, its own frame and a context', async()=>{
    const m = machine();
    const [frame] = m.registerFrames([0x51000]);

    await m.seh.dispatch({ code: 0xdeadbeef, address: 0x401234, parameters: [7, 9] });

    const [call] = m.called;
    const [record, given, context] = call.args;
    assert.equal(given, frame, 'the frame it was registered as');
    assert.equal(m.get(record + RECORD.CODE), 0xdeadbeef);
    assert.equal(m.get(record + RECORD.ADDRESS), 0x401234);
    assert.equal(m.get(record + RECORD.PARAMETER_COUNT), 2);
    assert.equal(m.get(record + RECORD.INFORMATION), 7);
    assert.equal(m.get(record + RECORD.INFORMATION + 4), 9);
    assert.equal(context, record + RECORD.SIZE + 4,
        'the context clears the record and the word after it');
    assert.equal(m.get(context + CONTEXT.EIP), 0x401000, 'the registers as they stood');
    assert.equal(m.get(context + CONTEXT.EAX), 0x11);
});

test('the context a handler gets holds the segment registers CONTEXT_FULL names', async()=>{
    // A handler that checks it ran at RPL 3, or restores the selectors it
    // was handed, finds a ring-3 thread's -- not zeros.
    const m = machine();
    m.registerFrames([0x51000]);
    await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });
    const [, , context] = m.called[0].args;
    assert.equal(m.get(context + CONTEXT.FLAGS) & 0x10004, 0x10004, 'CONTEXT_SEGMENTS');
    assert.deepEqual([CONTEXT.CS, CONTEXT.SS, CONTEXT.DS, CONTEXT.ES, CONTEXT.FS, CONTEXT.GS]
        .map(field=>m.get(context + field)), [0x1b, 0x23, 0x23, 0x23, 0x3b, 0]);
    assert.equal(SELECTORS.CODE & 3, 3, 'user code runs at RPL 3');
});

test('the record is built on the program\'s stack, below where it was', async()=>{
    // A fixed address aliases the record a rethrow still points at.
    const m = machine();
    m.registerFrames([0x51000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });

    const [{ args: [record] }] = m.called;
    assert.ok(record < STACK, 'below the stack pointer, not above it');
    assert.ok(STACK - record >= RECORD.SIZE + CONTEXT.SIZE,
        'with room for the record, the context and the handlers that run below them');
});

test('handlers run below the record they were handed', async()=>{
    // They push onto the same stack. A frame built where the call in flight
    // left the stack has the first handler's own frames grow down over the
    // context and then the record it is reading -- and a C++ frame handler
    // that reads a return address where the exception code was takes the
    // exception for a foreign one and declines it.
    /** @type {(number | undefined)[]} */
    const seen = [];
    const m = machine();
    const original = m.host.callGuest;
    m.host.callGuest = async call=>{
        seen.push(call.stackAtRest);
        return original(call);
    };
    m.registerFrames([0x51000, 0x52000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });
    await m.seh.unwind(0x20100, 0x401010);

    const [{ args: [record] }] = m.called;
    assert.equal(seen.length, 3);
    for (const stackAtRest of seen)
    {
        assert.ok(stackAtRest !== undefined && stackAtRest <= record,
            'the frame is built at or below the record');
    }
});

test('a context a handler changed is what execution continues with', async()=>{
    // Including the stack pointer: restoring only the instruction pointer
    // leaves the stack a frame out, every time.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    let recorded = 0;
    const original = m.host.callGuest;
    m.host.callGuest = async call=>{
        recorded = call.args[2];
        m.put(recorded + CONTEXT.EIP, 0x77000);
        m.put(recorded + CONTEXT.ESP, 0x3f000);
        m.put(recorded + CONTEXT.EAX, 0xabc);
        return original(call);
    };

    const result = await m.seh.dispatch({ code: 1, address: 0x401000 });

    assert.equal(result.handled, true);
    assert.equal(result.registers?.eip, 0x77000);
    assert.equal(result.registers?.esp, 0x3f000, 'the stack pointer too, not only the address');
    assert.equal(result.registers?.eax, 0xabc);
});

test("a handler's context carries the thread's debug registers, and continuing gives it new ones",
    async()=>{
        // A handler reads Dr6 for what stopped the thread and sets Dr0-Dr3/Dr7
        // in the record it continues from; the thread keeps what it set.
        const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
        const thread = {
            debugRegisters: { dr0: 0x1000, dr1: 0, dr2: 0, dr3: 0, dr6: 0x4000, dr7: 0 },
        };
        /** @type {any} */ (m.host).currentThread = ()=>thread;
        m.registerFrames([0x51000]);
        /** @type {number[]} */
        let seen = [];
        let flags = 0;
        const original = m.host.callGuest;
        m.host.callGuest = async call=>{
            const at = call.args[2];
            flags = m.get(at);
            seen = [4, 8, 0xc, 0x10, 0x14, 0x18].map(offset=>m.get(at + offset));
            m.put(at + 4, 0x42424240);
            m.put(at + 0x18, 0x115);
            return original(call);
        };
        const result = await m.seh.dispatch({ code: 0xc0000005, address: 0x401000 });
        assert.equal(result.handled, true);
        assert.equal(flags & 0x10010, 0x10010, 'the record names the debug registers');
        assert.deepEqual(seen, [0x1000, 0, 0, 0, 0x4000, 0]);
        assert.deepEqual(thread.debugRegisters,
            { dr0: 0x42424240, dr1: 0, dr2: 0, dr3: 0, dr6: 0x4000, dr7: 0x115 });
    });

test("a handler's context carries the thread's x87 and SSE state, and continuing puts it back",
    async()=>{
        // A .NET runtime resumes a thread it redirected for a collection by
        // raising an exception whose handler lays the thread's saved context
        // over the record and continues. The state was not in the record and
        // not put back: a thread stopped between a call that left its result
        // in ST(0) and the multiply that takes it went on with whatever the
        // runtime's own code had left there, and a world generator drew the
        // same random number for ever.
        const layout = { x87: 64, x87Top: 192, x87Empty: 193, x87Control: 194, x87Status: 196,
            x87Exact: 198, xmm: 208, mxcsr: 336 };
        const block = new Uint8Array(512);
        const state = new DataView(block.buffer);
        /** @param {number} top @param {number} value @param {number} lane */
        const load = (top, value, lane)=>{
            block.fill(0);
            block[layout.x87Top] = top;
            block[layout.x87Empty] = 0xff & ~(1 << top);
            state.setUint16(layout.x87Control, 0x27f, true);
            state.setFloat64(layout.x87 + top * 16, value, true);
            block.fill(lane, layout.xmm, layout.xmm + 16);
            state.setUint32(layout.mxcsr, 0x1f80, true);
        };
        const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
        // The processor's images, the running thread's with no context given.
        /** @type {any} */ (m.host).float = {
            images: (/** @type {any} */ context)=>floatImages(context ?? { block, layout }),
            restore: (/** @type {any} */ context, /** @type {any} */ images)=>
                restoreFloatImages(context ?? { block, layout }, images),
        };
        // What the thread's resume does with the registers a continuation
        // names (`resumeContextAt`): the floating-point images among them.
        /** @param {any} result */
        const resume = result=>restoreFloatImages({ block, layout }, result.registers.float);
        m.registerFrames([0x51000]);
        const original = m.host.callGuest;

        // The handler's own code leaves the registers changed; the record wins.
        load(7, 0.25, 0x11);
        let flags = 0;
        m.host.callGuest = async call=>{
            flags = m.get(call.args[2] + CONTEXT.FLAGS);
            load(3, 99, 0x77);
            return original(call);
        };
        const first = await m.seh.dispatch({ code: 1, address: 0x401000 });
        assert.equal(flags, 0x1003f,
            'CONTEXT_FULL with the debug, floating-point and extended groups (CONTEXT_ALL)');
        assert.equal(block[layout.x87Top], 3, 'not written where the handler returned:'
            + ' another thread may be on the processor by then');
        resume(first);
        assert.deepEqual([block[layout.x87Top], block[layout.x87Empty],
            state.getFloat64(layout.x87 + 7 * 16, true), block[layout.xmm]],
        [7, 0x7f, 0.25, 0x11], 'as it was at the exception');

        // A context laid over the record is what the thread goes on with.
        load(6, 1.5, 0x22);
        const saved = new Uint8Array(CONTEXT.SIZE);
        m.host.callGuest = async call=>{
            saved.set(m.host.readMemory(call.args[2], CONTEXT.SIZE));
            return Disposition.CONTINUE_SEARCH;
        };
        await m.seh.dispatch({ code: 1, address: 0x401000 });
        load(0, -3, 0x55);
        m.host.callGuest = async call=>{
            m.host.writeMemory(call.args[2], saved);
            return original(call);
        };
        resume(await m.seh.dispatch({ code: 1, address: 0x401000 }));
        assert.deepEqual([block[layout.x87Top], state.getFloat64(layout.x87 + 6 * 16, true),
            block[layout.xmm]], [6, 1.5, 0x22], "the saved thread's state");
    });

test('a frame whose handler is not there is passed over, not refused', async()=>{
    // The check is a bounds test. Demanding execute permission rejects the
    // program's own handler, because images are mapped readable.
    const m = machine();
    m.registerFrames([0, 0x52000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x52000]);
});

test('a nested exception stops the walk instead of repeating it', async()=>{
    const m = machine({ answer: entry=>
        entry === 0x52000 ? Disposition.NESTED_EXCEPTION : Disposition.CONTINUE_SEARCH });
    m.registerFrames([0x51000, 0x52000, 0x53000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000],
        'the third is not called; carrying on would not terminate');
});

test('a chain that points backwards ends the walk rather than looping', async()=>{
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);
    m.put(frames[1], frames[0]); // second points back at the first

    // No thread object: the machine's one block is the running thread's.
    const { frames: walked, damaged } = m.seh.chain(null);

    assert.equal(damaged, true);
    assert.equal(walked.length, 2, 'what was reached before it doubled back');
});

test('unwinding calls each handler with the unwinding flag, and stops at the target', async()=>{
    // A runtime that is not this compiler's depends on being called that way.
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000, 0x53000]);

    const result = await m.seh.unwind(frames[2], 0x401000);

    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000]);
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.FLAGS) & EH_UNWINDING, EH_UNWINDING);
    assert.equal(result.unwound, true);
    assert.equal(m.get(TEB), frames[2], 'and the head becomes the target');
});

test('an unwind to a frame that is not on the chain unwinds nothing', async()=>{
    // The target is the program's mistake. Taking every frame off on the way
    // to not finding it would destroy state the program still has, and
    // writing back the frame the walk gave up on publishes damage.
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);

    const result = await m.seh.unwind(0x79000, 0x401000);

    assert.equal(result.unwound, false);
    assert.deepEqual(m.called, [], 'no handler is told its frame is going');
    assert.equal(m.get(TEB), frames[0], 'unchanged');
});

test('each frame leaves the chain as its handler returns, not all at the end', async()=>{
    // A handler that raises while it runs -- a destructor that throws -- starts
    // a new dispatch from the head as it stands, and must not find the frames
    // already unwound still on it.
    /** @type {number[]} */
    const heads = [];
    const m = machine({ answer: ()=>{
        heads.push(m.get(TEB));
        return Disposition.CONTINUE_SEARCH;
    } });
    const frames = m.registerFrames([0x51000, 0x52000, 0x53000]);

    await m.seh.unwind(frames[2], 0x401000);

    assert.deepEqual(heads, [frames[0], frames[1]],
        'a handler runs with its own frame still at the head, and the one before it gone');
    assert.equal(m.get(TEB), frames[2]);
});

test('an unwind with no target takes every frame, and says it is an exit unwind', async()=>{
    const m = machine();
    m.registerFrames([0x51000, 0x52000]);

    const result = await m.seh.unwind(0, 0x401000);

    assert.equal(result.unwound, true);
    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000]);
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.FLAGS) & 0x06, 0x06, 'unwinding, and exit unwind');
    assert.equal(m.get(TEB), END_OF_CHAIN);
});

test('an unwind for an exception shows handlers that exception, flagged as unwinding', async()=>{
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);
    const exception = 0x31000;
    m.put(exception + RECORD.CODE, 0xe06d7363);

    await m.seh.unwind(frames[1], 0x401000, { record: exception });

    assert.equal(m.called[0].args[0], exception, 'the exception, not a record of its own');
    assert.equal(m.get(exception + RECORD.FLAGS) & EH_UNWINDING, EH_UNWINDING);
});

test('an unwind carves its record below the stack it is told, not the processor\'s', async()=>{
    // A caller that has awaited anything is no longer on the processor; what
    // the registers say by then belongs to whoever is.
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);

    await m.seh.unwind(frames[1], 0x401000, { registers: { esp: 0x70000 } });

    const [{ args: [record] }] = m.called;
    assert.ok(record < 0x70000 && record > 0x70000 - 0x400,
        `the record at 0x${record.toString(16)} is just below the stack given`);
});

test('a processor fault becomes an exception a program can handle', async()=>{
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);

    const result = await m.seh.onFault({ vector: 14, eip: 0x401500, errorCode: 2 },
        { ...m.registers(), eip: 0x401500 });

    assert.equal(result.handled, true, 'a program that faults on purpose is ordinary');
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), STATUS.ACCESS_VIOLATION);
    assert.equal(m.get(record + RECORD.INFORMATION), 1, 'error code bit 1 says it was a write');
});

test('a guard page touched inside the stack grows it, elsewhere it is the program\'s', async()=>{
    // Windows answers a stack's guard page itself: the page becomes the
    // committed limit, the one below the next guard, and the touch runs
    // again; with no room left above the reservation's bottom it is
    // STATUS_STACK_OVERFLOW, and a guard page anywhere else is
    // STATUS_GUARD_PAGE_VIOLATION with the access and address.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    /** @type {Set<number>} */
    const guarded = new Set([0x3f000, 0x31000, 0x60000]);
    /** @type {number[]} */
    const committed = [];
    const seh = createSeh({ ...m.host, guardPages: {
        touch: (/** @type {number} */ address)=>guarded.delete(address & ~0xfff),
        commitGuard: (/** @type {number} */ page)=>{
            committed.push(page);
            guarded.add(page);
            return true;
        },
    } });
    m.put(TEB + 4, 0x40000);
    m.put(TEB + 0xe0c, 0x30000);
    const at = { ...m.registers(), eip: 0x401500 };

    const grown = await seh.onFault({ vector: 14, eip: 0x401500, errorCode: 2,
        address: 0x3fffc }, at);
    assert.deepEqual(grown, { handled: true, registers: at }, 'the touch runs again');
    assert.deepEqual(committed, [0x3e000]);
    assert.equal(m.get(TEB + 8), 0x3f000, 'StackLimit');
    assert.equal(m.called.length, 0, 'no handler sees it');

    assert.equal((await seh.onFault({ vector: 14, eip: 0x401500, errorCode: 2,
        address: 0x31010 }, at)).handled, true);
    assert.deepEqual(committed, [0x3e000], 'no page left above the bottom');
    assert.equal(m.get(m.called[0].args[0] + RECORD.CODE), STATUS.STACK_OVERFLOW);

    await seh.onFault({ vector: 14, eip: 0x401500, errorCode: 0, address: 0x60008 }, at);
    const record = m.called[1].args[0];
    assert.equal(m.get(record + RECORD.CODE), STATUS.GUARD_PAGE_VIOLATION);
    assert.deepEqual([m.get(record + RECORD.INFORMATION), m.get(record + RECORD.INFORMATION + 4)],
        [0, 0x60008]);

    await seh.onFault({ vector: 14, eip: 0x401500, errorCode: 0, address: 0x60008 }, at);
    assert.equal(m.get(m.called[2].args[0] + RECORD.CODE), STATUS.ACCESS_VIOLATION,
        'the guard went with the first touch');
});

test('an instruction the processor refused is traced with its bytes', async()=>{
    // UD2 a protection raises on purpose and an opcode the translator lacks
    // both arrive as vector 6; only the bytes tell them apart.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    /** @type {string[]} */
    const said = [];
    const seh = createSeh({ ...m.host, trace: (/** @type {string} */ line)=>said.push(line) });
    m.registerFrames([0x51000]);
    m.host.writeMemory(0x41000, new Uint8Array([0x0f, 0x0b, 0xeb, 0x07, 0x22, 0x22, 0x22, 0x00]));

    await seh.onFault({ vector: 6, eip: 0x41000, errorCode: null },
        { ...m.registers(), eip: 0x41000 });

    assert.ok(said.some(line=>line.includes('at 0x41000 (0f 0b eb 07 22 22 22 00)')),
        said.join('\n'));
});

test('an access the program\'s own code was refused is traced with its registers, bytes and stack',
    async()=>{
        // A process that ends on it leaves nothing else to read, and code a
        // protection decrypts at run time is not in the file to disassemble.
        const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
        /** @type {string[]} */
        const said = [];
        const seh = createSeh({ ...m.host, trace: (/** @type {string} */ line)=>said.push(line) });
        m.registerFrames([0x51000]);
        m.host.writeMemory(0x41000,
            new Uint8Array([0x8b, 0x46, 0x0c, 0x90, 0x90, 0x90, 0x90, 0x90]));
        m.host.writeMemory(0x60000, new Uint8Array([0x78, 0x56, 0x34, 0x12]));
        await seh.onFault({ vector: 14, eip: 0x41000, errorCode: 0, address: 0xc },
            { ...m.registers(), eip: 0x41000, esi: 0, eax: 1, esp: 0x60000 });
        const line = said.find(one=>one.includes('reading 0xc')) ?? '';
        assert.match(line, /eax=0x1 .*esi=0x0 .*esp=0x60000/, said.join('\n'));
        assert.ok(line.includes('code 8b 46 0c 90 90 90 90 90'), line);
        assert.ok(line.includes('stack 0x12345678'), line);
    });

test('a refused access met in a host function is traced with that function\'s name', async()=>{
    // The address it was raised at is the function's trap, which names
    // nothing: the function and the pointer it was handed are the lead.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    /** @type {string[]} */
    const said = [];
    const seh = createSeh({ ...m.host, trace: (/** @type {string} */ line)=>said.push(line) });
    m.registerFrames([0x51000]);
    await seh.raiseAccess({ address: 0x801601e0, mode: 'read',
        call: 'KERNEL32.dll!LCMapStringEx' });
    assert.ok(said.some(line=>line.includes('reading 0x801601e0 in KERNEL32.dll!LCMapStringEx, '
        + 'raised from')), said.join('\n'));
});

test('a fault\'s context holds the registers the faulting code had', async()=>{
    // The stub that reported the fault has moved the stack and spent two
    // registers; the handler has to see the program's, not the stub's.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    const faulting = { ...m.registers(), eax: 0xa1, edx: 0xd1, esp: 0x60000, eip: 0x401500 };

    const result = await m.seh.onFault({ vector: 0, eip: 0x401500, errorCode: null }, faulting);

    const [{ args: [record, , context] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), STATUS.INTEGER_DIVIDE_BY_ZERO);
    assert.equal(m.get(context + CONTEXT.EAX), 0xa1);
    assert.equal(m.get(context + CONTEXT.EDX), 0xd1);
    assert.equal(m.get(context + CONTEXT.ESP), 0x60000);
    assert.ok(record < 0x60000, 'and the record is built below the faulting stack');
    assert.equal(result.registers?.eax, 0xa1, 'continuing resumes with them');
});

test('the debug service with no debugger is a breakpoint after it, or nothing at all', async()=>{
    // `int 0x2d`: eax the service, ecx and edx its arguments. A breakpoint or
    // prompt is raised as EXCEPTION_BREAKPOINT just past the instruction with
    // the three as parameters; a print or a symbol load goes on one byte past
    // it, raising nothing - the byte a protection's check hides there.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    const at = { ...m.registers(), eip: 0x401502, eax: 0, ecx: 0x1111, edx: 0x2222 };

    const raised = await m.seh.onFault({ vector: 0x2d, eip: 0x401502, errorCode: null }, at);

    const [{ args: [record, , context] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), STATUS.BREAKPOINT);
    assert.equal(m.get(record + RECORD.ADDRESS), 0x401502);
    assert.equal(m.get(record + RECORD.PARAMETER_COUNT), 3);
    assert.deepEqual([0, 4, 8].map(offset=>m.get(record + RECORD.INFORMATION + offset)),
        [0, 0x1111, 0x2222]);
    assert.equal(m.get(context + CONTEXT.EIP), 0x401502);
    assert.equal(raised.registers?.eip, 0x401502);

    for (const service of [1, 3, 4])
    {
        const quiet = await m.seh.onFault({ vector: 0x2d, eip: 0x401502, errorCode: null },
            { ...at, eax: service });
        assert.equal(quiet.handled, true);
        assert.equal(quiet.registers?.eip, 0x401503, `service ${service} skips a byte`);
    }
    assert.equal(m.called.length, 1, 'and offers no handler anything');
});

test('a protection fault is an access violation with no address to give', async()=>{
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);

    await m.seh.onFault({ vector: 13, eip: 0x401500, errorCode: 0 }, m.registers());

    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), STATUS.ACCESS_VIOLATION,
        'never a privileged instruction: the guest runs at ring zero');
    assert.equal(m.get(record + RECORD.INFORMATION + 4), 0xffffffff);
});

test('a vector no program can handle is not dressed up as one it can', async()=>{
    const m = machine();
    m.registerFrames([0x51000]);

    assert.equal(m.seh.claims(8), false);
    assert.equal(m.seh.claims(0), true);
    const result = await m.seh.onFault({ vector: 8, eip: 0x401500, errorCode: 0 }, m.registers());

    assert.equal(result.handled, false);
    assert.equal(m.called.length, 0, 'a double fault is not offered to the program');
});

test('a fault nothing took, with no last-chance filter, is left to be reported', async()=>{
    const m = machine();
    m.registerFrames([0x51000]);

    const result = await m.seh.onFault({ vector: 6, eip: 0x401500, errorCode: null },
        m.registers());

    assert.equal(result.handled, false, 'the report is the only account of it');
});

test('the top-level filter is guest code, and is called', async()=>{
    // A program's last-chance handler is where it writes its own account of the
    // failure; declining to run it is declining that account.
    const m = machine({ answer: ()=>1 });
    const { table } = m.seh;

    const previous = table.SetUnhandledExceptionFilter.handler([0x61000]);
    assert.equal(previous, 0, 'the one it replaced, so a caller can chain to it');

    const answer = await table.UnhandledExceptionFilter.handler([0x1234]);
    assert.equal(answer, 1);
    assert.deepEqual(m.called, [{ entry: 0x61000, args: [0x1234] }]);
});

test('under a debugger the top-level filter is not called: the debugger has the exception',
    async()=>{
        // Wine's kernel32 debugger.c test_unhandled_exception_filter: with a
        // debug port UnhandledExceptionFilter answers EXCEPTION_CONTINUE_SEARCH
        // and calls nothing; without one it calls the filter.
        const m = machine({ answer: ()=>1 });
        let debugged = true;
        const seh = createSeh({ ...m.host, debugReport: ()=>Promise.resolve(0),
            debugged: ()=>debugged });
        seh.table.SetUnhandledExceptionFilter.handler([0x61000]);
        assert.equal(await seh.table.UnhandledExceptionFilter.handler([0x1234]), 0);
        assert.deepEqual(m.called, []);
        debugged = false;
        assert.equal(await seh.table.UnhandledExceptionFilter.handler([0x1234]), 1);
        assert.deepEqual(m.called, [{ entry: 0x61000, args: [0x1234] }]);
    });

test('RaiseException dispatches instead of throwing', async()=>{
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    m.put(0x30000, 0xaa);
    m.put(0x30004, 0xbb);

    await m.seh.table.RaiseException.handler([0xe0000001, 0, 2, 0x30000]);

    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), 0xe0000001);
    assert.equal(m.get(record + RECORD.INFORMATION), 0xaa);
    assert.equal(m.get(record + RECORD.INFORMATION + 4), 0xbb);
});

test('RaiseException continues where the handler\'s context says, not back in its caller',
    async()=>{
        // Windows continues from the context whole (NtContinue). A .NET runtime
        // resumes a thread it redirected for a collection by raising an
        // exception whose handler lays the thread's saved context over the
        // record: returned to RaiseException's caller with only the other
        // registers taken, the thread went on in the runtime's stub with the
        // frame pointer of the code it was redirected from, the stub's epilogue
        // wrote that frame's locals into the handler chain and returned out of
        // the function the thread had been stopped in.
        const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
        /** @type {Record<string, number>[]} */
        const continued = [];
        /** @type {any} */ (m.host).continueAt = (/** @type {Record<string, number>} */ registers)=>{
            continued.push(registers);
            return 'continued';
        };
        m.registerFrames([0x51000]);
        // The call: its return address at the stack pointer, four arguments above.
        m.put(STACK, 0x402222);
        const original = m.host.callGuest;

        // Left as it was, the context is the caller's once the call has returned.
        let shown = { eip: 0, esp: 0 };
        m.host.callGuest = async call=>{
            shown = { eip: m.get(call.args[2] + CONTEXT.EIP),
                esp: m.get(call.args[2] + CONTEXT.ESP) };
            return original(call);
        };
        assert.equal(await m.seh.table.RaiseException.handler([0xe0000001, 0, 0, 0]), 'continued');
        assert.deepEqual(shown, { eip: 0x402222, esp: STACK + 20 },
            'the return address, and the stack past it and the four arguments');
        assert.deepEqual([continued[0].eip, continued[0].esp], [0x402222, STACK + 20]);

        // Laid over with another context, that one is where the thread goes.
        m.host.callGuest = async call=>{
            m.put(call.args[2] + CONTEXT.EIP, 0x77000);
            m.put(call.args[2] + CONTEXT.ESP, 0x3f000);
            m.put(call.args[2] + CONTEXT.EBP, 0x3f100);
            m.put(call.args[2] + CONTEXT.EAX, 0xabc);
            return original(call);
        };
        await m.seh.table.RaiseException.handler([0xe0434f4e, 0, 0, 0]);
        assert.deepEqual([continued[1].eip, continued[1].esp, continued[1].ebp, continued[1].eax],
            [0x77000, 0x3f000, 0x3f100, 0xabc]);
    });

test('an exception nothing handles ends the process with its code, and never returns', async()=>{
    /** @type {any[]} */
    const ended = [];
    const m = machine();
    const seh = createSeh({ ...m.host, terminate: what=>ended.push(what) });
    m.registerFrames([]);

    let returned = false;
    seh.table.RaiseException.handler([0xc0000017, 1, 0, 0]).then(()=>{
        returned = true;
    });
    await new Promise(resolve=>setImmediate(resolve));

    assert.deepEqual(ended, [{ code: 0xc0000017, address: 0x401000 }]);
    assert.equal(returned, false, 'the call that raised does not come back');
});

test('the last-chance filter is asked first, and can have the exception continue', async()=>{
    /** @type {any[]} */
    const ended = [];
    const m = machine({ answer: entry=>(entry === 0x61000 ? -1 : Disposition.CONTINUE_SEARCH) });
    const seh = createSeh({ ...m.host, terminate: what=>ended.push(what) });
    m.registerFrames([0x51000]);
    seh.table.SetUnhandledExceptionFilter.handler([0x61000]);

    const result = await seh.raise({ code: 0xe0000002, address: 0x401000 });

    assert.equal(result.handled, true);
    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x61000],
        'the chain first, then the filter');
    const [pointers] = m.called[1].args;
    assert.equal(m.get(pointers), m.called[0].args[0], 'handed the same record the chain saw');
    assert.deepEqual(ended, []);
});

test('RtlUnwind answers with the value it was given for EAX', async()=>{
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);

    const answer = await m.seh.table.RtlUnwind.handler([frames[1], 0x401000, 0, 0x1234]);

    assert.equal(answer, 0x1234);
    assert.equal(m.get(TEB), frames[1]);
});

test('a handler starts with DF, TF and AC clear, its context with what the fault had', async()=>{
    // A fault inside a copy going down (`std; rep movsd`) reaches the handler
    // with DF set on the processor; compiled code assumes it clear at every
    // call, so every `rep` in the handler would run backwards.
    const m = machine();
    m.registerFrames([0x51000, 0x52000]);
    const faulted = 0x202 | 0x1 | EFLAGS_DF | EFLAGS_TF | EFLAGS_AC;

    await m.seh.onFault({ vector: 14, eip: 0x401000, errorCode: 0 },
        { ...m.registers(), eflags: faulted });

    assert.deepEqual(m.startedWith, [0x203, 0x203],
        'every handler of the walk, with the carry and the rest as they were');
    const [, , context] = m.called[0].args;
    assert.equal(m.get(context + CONTEXT.EFLAGS), faulted, 'the context has the fault\'s own');
});

test('continuing from a context takes its flags, and keeps the thread\'s own bits', async()=>{
    // The handler may leave DF as the fault had it, or change the arithmetic
    // flags; IF and the reserved bit are the thread's, whatever the record
    // says.
    const m = machine({ answer: (entry, args)=>{
        m.put(args[2] + CONTEXT.EFLAGS, EFLAGS_DF | 0x1);
        return Disposition.CONTINUE_EXECUTION;
    } });
    m.registerFrames([0x51000]);

    const result = await m.seh.onFault({ vector: 14, eip: 0x401000, errorCode: 0 },
        { ...m.registers(), eflags: 0x202 | EFLAGS_DF | 0x40 });

    assert.equal(result.handled, true);
    assert.equal(result.registers?.eflags, 0x202 | EFLAGS_DF | 0x1,
        'DF and the carry from the context, IF and bit 1 from the thread, ZF gone as asked');
});

test('a raised exception with no frame goes to the filter with the flags a handler gets', async()=>{
    const m = machine({ answer: ()=>-1 });
    const seh = createSeh({ ...m.host, registers: ()=>({ ...m.registers(), eflags: 0x646 }) });
    m.registerFrames([]);
    seh.table.SetUnhandledExceptionFilter.handler([0x61000]);

    const result = await seh.raise({ code: 0xe0000002, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x61000]);
    assert.deepEqual(m.startedWith, [0x246]);
    assert.equal(result.registers?.eflags, 0x646, 'and continues with the context\'s');
});

test('without the exception\'s flags, a handler is told none and continues with none', async()=>{
    // A word nobody filled in is not the thread's flags.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    /** @type {Record<string, number>} */
    const known = { ...m.registers() };
    delete known.eflags;
    const seh = createSeh({ ...m.host, registers: ()=>({ ...known }) });
    m.registerFrames([0x51000]);

    const result = await seh.dispatch({ code: 1, address: 0x401000 });

    assert.deepEqual(m.startedWith, [undefined]);
    assert.equal(result.handled, true);
    assert.equal('eflags' in (result.registers ?? {}), false);
});

test('vectored handlers are offered an exception before any frame, in their order', async()=>{
    const m = machine();
    m.registerFrames([0x51000]);
    const table = m.seh.table;
    const second = table.AddVectoredExceptionHandler.handler([0, 0x61000]);
    const first = table.AddVectoredExceptionHandler.handler([1, 0x62000]);
    assert.ok(first !== 0 && second !== 0 && first !== second);
    assert.equal(table.AddVectoredExceptionHandler.handler([0, 0]), 0, 'no handler, no handle');

    await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });
    assert.deepEqual(m.called.map(call=>call.entry), [0x62000, 0x61000, 0x51000],
        'First goes in front, and then the frames');
    // Handed EXCEPTION_POINTERS: the record and the context the frame sees.
    const pointers = m.called[0].args[0];
    const frameCall = m.called[2];
    assert.equal(m.get(pointers), frameCall.args[0]);
    assert.equal(m.get(pointers + 4), frameCall.args[2]);
    assert.equal(m.get(m.get(pointers) + RECORD.CODE), STATUS.ACCESS_VIOLATION);

    assert.equal(table.RemoveVectoredExceptionHandler.handler([first]), 1);
    assert.equal(table.RemoveVectoredExceptionHandler.handler([first]), 0, 'once');
    m.called.length = 0;
    await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });
    assert.deepEqual(m.called.map(call=>call.entry), [0x61000, 0x51000]);
});

test('a vectored handler that fixes the exception goes on from its context, past the frames',
    async()=>{
        // EXCEPTION_CONTINUE_EXECUTION is -1; the continue handlers then see
        // the same pointers.
        const m = machine({ answer: entry=>(entry === 0x61000 ? 0xffffffff : 0) });
        m.registerFrames([0x51000]);
        const table = m.seh.table;
        table.AddVectoredExceptionHandler.handler([0, 0x61000]);
        table.AddVectoredContinueHandler.handler([0, 0x63000]);
        // The handler skips the faulting instruction, as a program's does.
        const original = m.host.callGuest;
        m.host.callGuest = async call=>{
            if (call.entry === 0x61000)
            {
                const context = m.get(call.args[0] + 4);
                m.put(context + CONTEXT.EIP, 0x401003);
            }
            return original(call);
        };
        const result = await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });
        assert.equal(result.handled, true);
        assert.equal(result.registers?.eip, 0x401003);
        assert.deepEqual(m.called.map(call=>call.entry), [0x61000, 0x63000],
            'no frame asked, the continue handler told');
        assert.equal(m.called[1].args[0], m.called[0].args[0]);
    });

test('a frame that fixes the exception tells the continue handlers too', async()=>{
    const m = machine({ answer: entry=>(entry === 0x51000 ? Disposition.CONTINUE_EXECUTION
        : Disposition.CONTINUE_SEARCH) });
    m.registerFrames([0x51000]);
    const handle = m.seh.table.AddVectoredContinueHandler.handler([0, 0x63000]);
    await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });
    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x63000]);
    assert.equal(m.seh.table.RemoveVectoredContinueHandler.handler([handle]), 1);
});

test('a handler is called with the dispatch\'s own frame at the head, as the C runtime\'s catch'
    + ' counts on', async()=>{
    // What a statically linked runtime's frame handler does on finding the
    // catch in the head frame: saves the head ("the system's frame"), unwinds
    // to its own frame, links the saved one back on above it, and before the
    // jump to the continuation takes the head off. Without a frame of the
    // dispatch's at the head that linked the catching frame to itself and
    // then left it at the head after its function had returned.
    const DISPATCHER = 0x5f000;
    const m = machine();
    Object.assign(m.host, { dispatcherHandler: ()=>DISPATCHER });
    const seh = createSeh(m.host);
    // Above the stack, where a program's frames are: the dispatch's own
    // frame is below them.
    const frames = [STACK + 0x100, STACK + 0x200];
    m.put(frames[0], frames[1]);
    m.put(frames[0] + 4, 0x51000);
    m.put(frames[1], END_OF_CHAIN);
    m.put(frames[1] + 4, 0x52000);
    m.put(TEB, frames[0]);
    /** @type {number[]} */
    let walked = [];
    const original = m.host.callGuest;
    m.host.callGuest = async call=>{
        if (call.entry !== 0x51000)
        {
            return original(call);
        }
        const saved = m.get(TEB);
        walked = seh.chain(null).frames.map(({ handler })=>handler);
        await seh.unwind(frames[0], 0x401000);
        m.put(saved, m.get(TEB));
        m.put(TEB, saved);
        // The catch block ran; the continuation's jump takes the head off and
        // never returns to the dispatch.
        m.put(TEB, m.get(m.get(TEB)));
        return new Promise(()=>{});
    };

    void seh.dispatch({ code: 0xe06d7363, address: 0x401000 });
    await new Promise(resolve=>setTimeout(resolve, 0));

    assert.deepEqual(walked, [DISPATCHER, 0x51000, 0x52000], 'the handler finds its frame below');
    assert.equal(m.get(TEB), frames[0], 'the catching frame is the head again');
    assert.equal(m.get(frames[0]), frames[1], 'still linked to the frame it was');
    assert.ok(!m.called.some(call=>call.entry === DISPATCHER),
        'the unwind takes the dispatch\'s frame off without calling it');
});

test('a handler that declines leaves the head where it was', async()=>{
    const m = machine();
    Object.assign(m.host, { dispatcherHandler: ()=>0x5f000 });
    const seh = createSeh(m.host);
    const frames = m.registerFrames([0x51000, 0x52000]);

    await seh.dispatch({ code: 1, address: 0x401000 });

    assert.equal(m.get(TEB), frames[0]);
});

test('a refused guest access is STATUS_ACCESS_VIOLATION, read or write and where', async()=>{
    // Windows faults at the DLL's own instruction when a program hands it a
    // pointer that is not there, and the program's handlers see the access
    // violation: what it did and the address it could not reach.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    const answer = await m.seh.raiseAccess({ address: 0xdeadbeef, mode: 'write' });
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), 0xc0000005);
    assert.equal(m.get(record + RECORD.PARAMETER_COUNT), 2);
    assert.equal(m.get(record + RECORD.INFORMATION), 1, 'a write');
    assert.equal(m.get(record + RECORD.INFORMATION + 4), 0xdeadbeef);
    assert.equal(answer, 0, 'continued, the call answers zero');

    const read = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    read.registerFrames([0x51000]);
    await read.seh.raiseAccess({ address: 0, mode: 'read' });
    const [{ args: [readRecord] }] = read.called;
    assert.deepEqual([read.get(readRecord + RECORD.INFORMATION),
        read.get(readRecord + RECORD.INFORMATION + 4)], [0, 0]);
});

test('an exception a handler raises reaches the program with its code and '
    + 'information', async()=>{
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    const answer = await m.seh.raiseException({ status: 0xc0000094, flags: 0, parameters: [7] });
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), 0xc0000094);
    assert.equal(m.get(record + RECORD.FLAGS), 0);
    assert.equal(m.get(record + RECORD.PARAMETER_COUNT), 1);
    assert.equal(m.get(record + RECORD.INFORMATION), 7);
    assert.equal(answer, 0, 'continued, the call answers zero');
});

test('what a program hands its last-chance filter is traced: registers, chain and words', async()=>{
    // A fail-fast calls the filter and ends: the trace is all that is left.
    const m = machine({ answer: ()=>1 });
    /** @type {string[]} */
    const said = [];
    const seh = createSeh({ ...m.host, trace: (/** @type {string} */ line)=>said.push(line) });
    m.registerFrames([0x51000]);
    const record = 0x30000;
    const context = 0x31000;
    m.put(record, 0xc0000409);
    m.put(record + 0x0c, 0x401234);
    m.put(context + 0xb4, 0x40100);
    m.put(context + 0xc4, 0x40000);
    m.put(0x40100 - 64, 0xfeedface);
    m.put(0x40000 + 0x2c4, 0xc0ffee);
    m.put(0x2000, record);
    m.put(0x2004, context);
    seh.table.SetUnhandledExceptionFilter.handler([0x61000]);

    await seh.table.UnhandledExceptionFilter.handler([0x2000]);

    const text = said.join('\n');
    assert.ok(text.includes('last chance: code 0xc0000409 at 0x401234'), text);
    assert.ok(text.includes('ebp=0x40100') && text.includes('esp=0x40000'), text);
    assert.ok(text.includes('[ebp-64] 0xfeedface'), text);
    assert.ok(/0x402c0: \S+ 0xc0ffee /.test(text), 'the stack above esp, row by row');
    assert.ok(text.includes('0x20000>0x51000'), 'the handler chain');
});

test('the last-chance trace reads nothing below a small register, and never fails the call',
    async()=>{
    // A register holding 3 named 3 - 64 as a place to read from: unsigned,
    // the top of the address space, which a memory may say is mapped.
        const m = machine({ answer: ()=>1 });
        /** @type {string[]} */
        const said = [];
        const seh = createSeh({ ...m.host,
            isMapped: (/** @type {number} */ at)=>m.host.isMapped(at) || (at >>> 0) >= 0xffffff00,
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
                if ((at >>> 0) >= 0xffffff00)
                {
                    throw new Error('access violation');
                }
                return m.host.readMemory(at, length);
            },
            trace: (/** @type {string} */ line)=>said.push(line) });
        m.put(0x30000, 0xc0000409);
        m.put(0x31000 + 0xb0, 3);
        m.put(0x2000, 0x30000);
        m.put(0x2004, 0x31000);
        seh.table.SetUnhandledExceptionFilter.handler([0x61000]);

        assert.equal(await seh.table.UnhandledExceptionFilter.handler([0x2000]), 1,
            'the filter answered');
        assert.ok(said.some(line=>line.includes('eax=0x3')), said.join('\n'));
    });

test('RtlUnwind shows the caller\'s context and answers the Eax its handlers leave', async()=>{
    // Wine's exception test, test_unwind: the handlers see Eip at the return
    // from RtlUnwind and ReturnValue in Eax; one that adds to Eax changes
    // what the call returns.
    const m = machine({ answer: (_entry, args)=>{
        m.put(args[2] + CONTEXT.EAX, m.get(args[2] + CONTEXT.EAX) + 1);
        return Disposition.CONTINUE_SEARCH;
    } });
    const frames = m.registerFrames([0x51000, 0x52000]);
    m.put(STACK, 0x401234);
    const answer = await /** @type {any} */ (m.seh.table).RtlUnwind
        .handler([frames[1], 0x401999, 0, 0xdead0000]);

    assert.equal(answer >>> 0, 0xdead0001, 'one handler ran, and its Eax is the answer');
    const [{ args: [record, , context] }] = m.called;
    assert.equal(m.get(context + CONTEXT.EIP), 0x401234, 'the return address, not the trap');
    assert.equal(m.get(context + CONTEXT.ESP), STACK + 4 + 16, 'past the four arguments');
    assert.equal(m.get(record + RECORD.CODE), STATUS.UNWIND);
    assert.equal(m.get(record + RECORD.ADDRESS), 0x401234);

    const none = await /** @type {any} */ (m.seh.table).RtlUnwind
        .handler([frames[1], 0, 0, 0xdead0000]);
    assert.equal(none >>> 0, 0xdead0000, 'with no frame left to unwind, ReturnValue as given');
});
