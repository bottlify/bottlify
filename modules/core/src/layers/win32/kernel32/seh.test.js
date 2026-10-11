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
        readMemory: (at, length)=>bytes.subarray(at, at + length),
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
    // Not the shape the emulator keeps. Every one of these is a translation,
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
