/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What was happening when it went wrong.
 *
 * A guest failure arrives as an address and nothing else, and an address on its
 * own answers no question anybody has. This turns the machine's state into the
 * three things that actually locate a fault: where the CPU was, how it got
 * there, and which of our own functions were in the middle of running.
 *
 * The walk of the guest stack is a scan, not an unwind. There is no unwind
 * information for a program compiled decades ago, and the frame-pointer chain
 * is only there when the compiler felt like keeping it -- so the frame chain is
 * followed while it stays plausible, and what is reported beyond that is every
 * word on the stack that could be a return address, labelled as the guess it
 * is. A noisy list containing the answer beats a clean list without it.
 */

/** How far up the stack to look, and how many frames to report. */
const SCAN_BYTES = 0x400;
const MAX_FRAMES = 24;

/**
 * How much of what a register points at to show.
 *
 * A register naming a region answers where a pointer came from; the bytes
 * behind it answer whether what is there is what the program expected, which is
 * the question a bad pointer actually raises. Two lines is enough to recognise
 * a structure, a string, or a block of zeroes nobody filled in.
 */
const PEEK_BYTES = 32;

/** The general-purpose registers, in the order a person reads them. */
const REGISTERS = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'];

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/**
 * @typedef {Object} TraceSources
 * @property {any} cpu
 * @property {any} memory
 * @property {any} kernel
 * @property {any} bridge
 */

/**
 * Names an address: which of our stubs it is, or which region it falls in and
 * how far into it. An address inside the image is reported as an RVA too,
 * because that is the number a disassembler of the same binary agrees with.
 *
 * @param {TraceSources} sources
 * @param {number} address
 * @returns {string}
 */
export function describeAddress({ memory, bridge }, address){
    const at = address >>> 0;
    const symbol = bridge.symbolize(at);
    if (symbol)
    {
        return `${hex(at)} ${symbol}`;
    }

    let region = null;
    try
    {
        region = memory.find(at);
    }
    catch (e){
        void e;
    }
    if (!region)
    {
        return `${hex(at)} <unmapped>`;
    }

    const offset = hex(at - region.base);
    // Inside a mapped image the offset is the RVA, which is the number a
    // disassembler of the same binary agrees with; say so rather than make the
    // reader work it out.
    return region.kind === 'image'
        ? `${hex(at)} ${region.name}+${offset} (rva ${offset})`
        : `${hex(at)} ${region.name}+${offset}`;
}

/**
 * The bytes at an address, as hexadecimal and as text, or null if unreadable.
 *
 * @param {TraceSources} sources
 * @param {number} address
 * @param {number} [length]
 * @returns {string[] | null}
 */
export function peekBytes({ memory }, address, length = PEEK_BYTES){
    let bytes;
    try
    {
        bytes = memory.readBytes(address >>> 0, length);
    }
    catch (e){
        void e;
        return null;
    }
    const lines = [];
    for (let at = 0; at < bytes.length; at += 16)
    {
        const row = bytes.subarray(at, at + 16);
        const hexadecimal = [...row]
            .map((/** @type {number} */ b)=>b.toString(16).padStart(2, '0')).join(' ');
        const text = [...row]
            .map((/** @type {number} */ b)=>b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
            .join('');
        lines.push(`${hexadecimal.padEnd(47)}  |${text}|`);
    }
    return lines;
}

/**
 * @param {TraceSources} sources
 * @param {number} address
 */
function isCode({ memory, bridge }, address){
    if (bridge.symbolize(address))
    {
        return true;
    }
    try
    {
        const region = memory.find(address);
        return Boolean(region) && (region.kind === 'image' || region.kind === 'thunk_code');
    }
    catch (e){
        void e;
        return false;
    }
}

/**
 * Reads the guest stack and reports what on it looks like a way back.
 *
 * @param {TraceSources} sources
 * @param {number} esp
 * @param {number} ebp
 * @returns {{ frames: string[], truncated: boolean }}
 */
function walkStack(sources, esp, ebp){
    const { memory } = sources;
    /** @type {string[]} */
    const frames = [];

    // The frame-pointer chain first, while it stays plausible: each link must
    // point upward, stay on the stack, and carry a return address that is code.
    let frame = ebp >>> 0;
    let previous = esp >>> 0;
    while (frames.length < MAX_FRAMES && frame > previous && frame - previous < SCAN_BYTES)
    {
        let next;
        let returnAddress;
        try
        {
            next = memory.readU32(frame);
            returnAddress = memory.readU32(frame + 4);
        }
        catch (e){
            void e;
            break;
        }
        if (!isCode(sources, returnAddress))
        {
            break;
        }
        frames.push(`  ${describeAddress(sources, returnAddress)}`);
        previous = frame;
        frame = next >>> 0;
    }

    // Then everything else on the stack that could be a return address. Some of
    // it is stale and some is data that happens to look like a pointer, which is
    // why it is a separate, labelled section rather than more frames.
    /** @type {string[]} */
    const scanned = [];
    for (let at = esp >>> 0; at < (esp >>> 0) + SCAN_BYTES; at += 4)
    {
        let value;
        try
        {
            value = memory.readU32(at);
        }
        catch (e){
            void e;
            break;
        }
        if (isCode(sources, value))
        {
            scanned.push(`  ${hex(at)}: ${describeAddress(sources, value)}`);
        }
        if (scanned.length >= MAX_FRAMES)
        {
            break;
        }
    }

    return {
        frames: [
            ...frames.length > 0 ? ['frame chain:', ...frames] : [],
            ...scanned.length > 0 ? ['stack (may include stale entries):', ...scanned] : [],
        ],
        truncated: scanned.length >= MAX_FRAMES,
    };
}

/**
 * Captures everything worth knowing about a failure, as data.
 *
 * Never throws: a trace is taken when something has already gone wrong, and a
 * diagnostic that fails at that moment takes the diagnosis with it. Whatever
 * could not be read is simply absent.
 *
 * @param {TraceSources} sources
 * @returns {any}
 */
export function captureTrace(sources){
    const { cpu, kernel, bridge } = sources;
    const trace = /** @type {any} */ ({});

    try
    {
        trace.eip = cpu.eip();
        trace.at = describeAddress(sources, trace.eip);
        // What a register points at, when it points at anything nameable. A
        // register holding a function's address is the whole answer to "what
        // was it about to call", and reading that out of a hexadecimal number
        // by hand is a step nobody should take twice.
        trace.registers = Object.fromEntries(
            REGISTERS.map(name=>[name, cpu.readReg32(name)]));
        trace.pointing = Object.fromEntries(Object.entries(trace.registers)
            .map(([name, value])=>[name, describeAddress(sources, Number(value))])
            .filter(([, where])=>!String(where).endsWith('<unmapped>')));
        // And what is actually there. The address says which allocation a
        // pointer came from; the bytes say whether it holds what the program
        // was expecting, which is the question a wild pointer raises.
        trace.peek = Object.fromEntries([
            ['eip', peekBytes(sources, trace.eip, 16)],
            ...Object.keys(trace.pointing)
                .map(name=>[name, peekBytes(sources, Number(trace.registers[name]))]),
        ].filter(([, lines])=>lines !== null));
        trace.instructions = cpu.instructionCount();
        trace.protectedMode = cpu.inProtectedMode();
    }
    catch (e){
        trace.cpuUnavailable = String(e);
    }

    try
    {
        // Which of our own functions were running: the outermost is the call the
        // guest made, the rest are what it led to.
        trace.hostCalls = bridge.chain();
        trace.recentCalls = bridge.recent();
    }
    catch (e){
        void e;
    }

    try
    {
        const thread = kernel.currentThread();
        trace.thread = thread ? { id: thread.id, name: thread.name, state: thread.state } : null;
        trace.threads = kernel.diagnosticsSnapshot();
    }
    catch (e){
        void e;
    }

    try
    {
        const { frames, truncated } = walkStack(
            sources, trace.registers.esp, trace.registers.ebp);
        trace.stack = frames;
        trace.stackTruncated = truncated;
    }
    catch (e){
        void e;
    }

    return trace;
}

/**
 * Renders a trace as the block a person reads in a terminal or a bug report.
 *
 * @param {any} trace
 * @returns {string}
 */
export function formatTrace(trace){
    const lines = [];
    if (trace.at)
    {
        lines.push(`at ${trace.at}`);
    }
    if (trace.thread)
    {
        lines.push(`thread ${trace.thread.name} (${trace.thread.state})`);
    }
    if (trace.registers)
    {
        const pairs = Object.entries(trace.registers)
            .map(([name, value])=>`${name}=${hex(Number(value))}`);
        // Four to a line: eight registers on one line is a wall nobody reads.
        for (let at = 0; at < pairs.length; at += 4)
        {
            lines.push(`  ${pairs.slice(at, at + 4).join(' ')}`);
        }
    }
    // Only the registers that name something. Every register described would
    // be a wall, and the ones holding a count or a flag describe nothing.
    for (const [name, where] of Object.entries(trace.pointing ?? {}))
    {
        if (!/^(esp|ebp)$/.test(name))
        {
            lines.push(`  ${name} -> ${where}`);
            for (const row of trace.peek?.[name] ?? [])
            {
                lines.push(`        ${row}`);
            }
        }
    }
    // What the processor is about to run, for whoever has the same binary open
    // in a disassembler: these are the bytes to look for.
    for (const row of trace.peek?.eip ?? [])
    {
        lines.push(`  code: ${row}`);
    }
    if (trace.hostCalls?.length > 0)
    {
        lines.push(`inside: ${trace.hostCalls.join(' -> ')}`);
    }
    if (trace.recentCalls?.length > 0)
    {
        lines.push(`last calls: ${trace.recentCalls.join(', ')}`);
    }
    // Every blocked thread and what it is waiting on. This was captured all
    // along and never rendered, which made the report of a stalled machine the
    // one report that could not be read: a parked thread's registers describe
    // the park loop and nothing else, so the only thing that names the failure
    // is the list of what nobody is signalling.
    if (trace.threads?.waiting?.length > 0)
    {
        lines.push('waiting:');
        for (const entry of trace.threads.waiting)
        {
            lines.push(`  ${entry}`);
        }
    }
    if (trace.stack?.length > 0)
    {
        lines.push(...trace.stack);
    }
    return lines.join('\n');
}
