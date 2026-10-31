/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The interpreter tier in wasm: cork's integer instruction set run straight from
 * guest memory, over cork's own layout -- the state block at the start of the
 * memory, guest RAM at `ramBase`, the page flags, code ranges and entry hash in
 * the tables. `interp-wasm.js` loads it; `scripts/build-interp-wasm.mjs` builds
 * it with `clang --target=wasm32` into `interp-wasm.bytes.js`.
 *
 * It decodes each instruction as it executes it, so code written in place needs
 * nothing: the next fetch reads what is there. The arithmetic flags are lazy --
 * the last writer's kind, operands and result -- and folded where read.
 * Semantics are ir.js's, the reference the hardware corpus judges: undefined
 * flags keep their value, logic ops clear AF, a push that faults leaves esp.
 *
 * x87 and SSE are helpers of its own (below). What it does not model -- MMX,
 * the system and rare forms, a fetch from a page it cannot read -- it leaves
 * unexecuted with eip at the instruction, answering W_UNSUPPORTED, and the
 * JavaScript interpreter runs it.
 * A store into translated code ends the run after the store with its address,
 * so the host invalidates what was translated there; a jump's target is counted
 * for hotness and looked up in the entry hash, and either can end the run for
 * the host to act on.
 *
 * Its own data and stack live below guest RAM (`--global-base=4096`, an 8 KiB
 * stack), past the 512-byte state block: cork's layout keeps that page for the
 * state block alone and nothing else writes there.
 *
 * Built a second time with LONG defined, it is long mode's tier, over the
 * 64-bit state block (`longLayout`) as `interp64.js` is, and `ir64.js` is its
 * reference: sixteen quadword registers, REX, RIP-relative operands, 64-bit
 * stack operations, a dword write zero-extending its register, FS and GS with
 * bases of their own. Guest memory is a window of 4 GiB from `ramBase`: an
 * access that reaches 2^32 faults (#GP), and code at the window's top is the
 * host's to fetch. The flags word in the block must be whole when a run starts:
 * the record translated long-mode code leaves is the host's to fold first. The
 * address-size prefix, a 16-bit stack operation and every form the 32-bit tier
 * leaves are left to `interp64.js` the same way.
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef signed char i8;
typedef short i16;
typedef int i32;
typedef long long i64;

/* How `run` ended; interp-wasm.js has the same numbers. */
enum
{
    W_BUDGET = 1, W_UNSUPPORTED = 2, W_HALT = 3, W_FAULT = 4, W_TRAP = 5, W_CODE_WRITE = 6,
    W_HOT = 7, W_ENTRY = 8,
};

#define CF 0x1u
#define PF 0x4u
#define AF 0x10u
#define ZF 0x40u
#define SF 0x80u
#define DF 0x400u
#define OF 0x800u
#define ARITH (CF | PF | AF | ZF | SF | OF)
#define INACCESSIBLE 1u
#define HAS_CODE 2u
/* A page with a block closed in a translated loop (PageFlag.CLOSED): see enter. */
#define CLOSED 8u
#define NO_EXECUTE 16u
/* A page watched for writes (PageFlag.WATCH): a store there is left to the
 * JavaScript tier, which marks the page written; the next is a store as any. */
#define WATCH 4u
#define NONE 0xffffffffu

static u8 *ram;
static u8 *pageFlags;
static u8 *codeRanges;
#ifdef LONG
static u64 *regs;
static u64 *ripField;
static u32 *eflagsField;
static u64 *fsBaseField;
static u64 *gsBaseField;
#else
static u32 *regs;
static u32 *eipField;
static u32 *eflagsField;
static u32 *fsBaseField;
#endif
static u8 *hotCounts;
static u32 hotMask;
static u32 hotThreshold;
static u8 *hash;
static u32 hashShift;
static u32 trapPort;
static u32 *starts;
static u32 *startAt;
static u32 parkBase;

/* The x87 state in the block: the eight registers as doubles by physical
 * number, one every sixteen bytes, and the top, the empty mask, the control
 * and the status word beside them. */
static u8 *x87Regs;
static u8 *x87TopAt;
static u8 *x87EmptyAt;
static u16 *x87ControlAt;
static u16 *x87StatusAt;
/* Where the block keeps the exact quadwords' marks between runs (see exactIn). */
static u8 *exactAt;
/* The XMM registers, four words each, and MXCSR, in the block. */
static u32 *xmmRegs;
static u32 *mxcsrAt;
/* The engine's `precise`: unless it is set, the x87 bookkeeping games do not
 * read is not kept (see the float section). */
static u32 precise;
/* Status-word stores (fnstsw) run while not precise: what a relaxed bit could reach. */
static u32 relaxedReads;
/* The block's instruction counter, which a run translated code makes (enter) adds
 * to as the host adds a run's; and what those runs retired, all told, in the area
 * past the ring's index, where the host reads it. */
static u32 *counterAt;
static u32 *enteredAt;

static u32 retired;
static u32 exitValue;
static u32 exitSize;

__attribute__((export_name("configure")))
void configure(u32 ramBase, u32 pageFlagsAt, u32 codeRangesAt, u32 hashAt, u32 hashShiftBits,
    u32 regsAt, u32 eipAt, u32 eflagsAt, u32 fsBaseAt, u32 area, u32 hotSlots, u32 threshold,
    u32 port, u32 park)
{
    ram = (u8 *)ramBase;
    pageFlags = (u8 *)pageFlagsAt;
    codeRanges = (u8 *)codeRangesAt;
    hash = (u8 *)hashAt;
    hashShift = hashShiftBits;
#ifdef LONG
    regs = (u64 *)regsAt;
    ripField = (u64 *)eipAt;
    eflagsField = (u32 *)eflagsAt;
    fsBaseField = (u64 *)fsBaseAt;
#else
    regs = (u32 *)regsAt;
    eipField = (u32 *)eipAt;
    eflagsField = (u32 *)eflagsAt;
    fsBaseField = (u32 *)fsBaseAt;
#endif
    hotCounts = (u8 *)area;
    hotMask = hotSlots - 1;
    hotThreshold = threshold;
    starts = (u32 *)(area + hotSlots);
    startAt = starts + 256;
    enteredAt = startAt + 1;
    trapPort = port;
    parkBase = park;
}

#ifdef LONG
/* GS's base, which only long mode's block has. */
__attribute__((export_name("configureLong")))
void configureLong(u32 gsBaseAt)
{
    gsBaseField = (u64 *)gsBaseAt;
}
#endif

__attribute__((export_name("configureFloat")))
void configureFloat(u32 x87At, u32 topAt, u32 emptyAt, u32 controlAt, u32 statusAt, u32 exact,
    u32 xmmAt, u32 mxcsrField)
{
    precise = exact;
    xmmRegs = (u32 *)xmmAt;
    mxcsrAt = (u32 *)mxcsrField;
    x87Regs = (u8 *)x87At;
    x87TopAt = (u8 *)topAt;
    x87EmptyAt = (u8 *)emptyAt;
    x87ControlAt = (u16 *)controlAt;
    x87StatusAt = (u16 *)statusAt;
}

__attribute__((export_name("retired"))) u32 getRetired(void) { return retired; }
__attribute__((export_name("relaxedReads"))) u32 getRelaxedReads(void) { return relaxedReads; }
__attribute__((export_name("exitValue"))) u32 getExitValue(void) { return exitValue; }
__attribute__((export_name("exitSize"))) u32 getExitSize(void) { return exitSize; }
__attribute__((export_name("configureEntry")))
void configureEntry(u32 counterField)
{
    counterAt = (u32 *)counterField;
}
__attribute__((export_name("configureExact")))
void configureExact(u32 field)
{
    exactAt = (u8 *)field;
}
/* The engine's `atomic`: a process whose threads run on more than one executor.
 * A locked instruction -- a `lock` prefix, `xchg` with memory -- is then the
 * JavaScript interpreter's, which makes it one indivisible access as the
 * translated code does; this module has no atomics to make it with. */
static u32 atomic;
__attribute__((export_name("configureAtomic")))
void configureAtomic(u32 on)
{
    atomic = on;
}

static const u8 PARITY[256] = {
#define P2(n) n, n ^ 1, n ^ 1, n
#define P4(n) P2(n), P2(n ^ 1), P2(n ^ 1), P2(n)
#define P6(n) P4(n), P4(n ^ 1), P4(n ^ 1), P4(n)
    P6(1), P6(0), P6(0), P6(1)
};
#ifdef LONG
/* Operands by size index, 3 for a quadword; a value of a size is a u64 here. */
static const u64 MASKS[4] = { 0xff, 0xffff, 0xffffffff, 0xffffffffffffffffull };
static const u64 SIGNS[4] = { 0x80, 0x8000, 0x80000000, 0x8000000000000000ull };

#define SIZE_INDEX(size) ((u32)__builtin_ctz(size))
#define WINDOW 0x100000000ull

/* A byte register: with any REX the low byte of each of the sixteen, without
 * one 4..7 are AH..BH. */
static inline u64 reg8(u32 r, u32 rex)
{
    return rex ? ((u8 *)regs)[r << 3] : ((u8 *)regs)[((r & 3) << 3) | (r >> 2)];
}
static inline void setReg8(u32 r, u32 rex, u64 v)
{
    if (rex) ((u8 *)regs)[r << 3] = (u8)v;
    else ((u8 *)regs)[((r & 3) << 3) | (r >> 2)] = (u8)v;
}
static inline u64 reg16(u32 r) { return ((u16 *)regs)[r << 2]; }
static inline void setReg16(u32 r, u64 v) { ((u16 *)regs)[r << 2] = (u16)v; }
static inline u64 regOf(u32 r, u32 size, u32 rex)
{
    return size == 8 ? regs[r] : size == 4 ? (u32)regs[r] : size == 2 ? reg16(r) : reg8(r, rex);
}
/* A dword write zero-extends into the whole register; a word or a byte merges. */
static inline void setRegOf(u32 r, u32 size, u32 rex, u64 v)
{
    if (size == 8) regs[r] = v;
    else if (size == 4) regs[r] = (u32)v;
    else if (size == 2) setReg16(r, v);
    else setReg8(r, rex, v);
}
static inline u64 load(u32 a, u32 size)
{
    return size == 8 ? *(u64 *)(ram + a) : size == 4 ? *(u32 *)(ram + a)
        : size == 2 ? *(u16 *)(ram + a) : ram[a];
}
static inline void store(u32 a, u32 size, u64 v)
{
    if (size == 8) *(u64 *)(ram + a) = v;
    else if (size == 4) *(u32 *)(ram + a) = (u32)v;
    else if (size == 2) *(u16 *)(ram + a) = (u16)v;
    else ram[a] = (u8)v;
}
#else
static const u32 MASKS[3] = { 0xff, 0xffff, 0xffffffff };
static const u32 SIGNS[3] = { 0x80, 0x8000, 0x80000000 };

#define SIZE_INDEX(size) ((size) == 4 ? 2 : (size) >> 1)

static inline u32 reg8(u32 r) { return ((u8 *)regs)[((r & 3) << 2) | (r >> 2)]; }
static inline void setReg8(u32 r, u32 v) { ((u8 *)regs)[((r & 3) << 2) | (r >> 2)] = (u8)v; }
static inline u32 reg16(u32 r) { return ((u16 *)regs)[r << 1]; }
static inline void setReg16(u32 r, u32 v) { ((u16 *)regs)[r << 1] = (u16)v; }
static inline u32 regOf(u32 r, u32 size) { return size == 4 ? regs[r] : size == 2 ? reg16(r) : reg8(r); }
static inline void setRegOf(u32 r, u32 size, u32 v)
{
    if (size == 4) regs[r] = v;
    else if (size == 2) setReg16(r, v);
    else setReg8(r, v);
}
static inline u32 load(u32 a, u32 size)
{
    return size == 4 ? *(u32 *)(ram + a) : size == 2 ? *(u16 *)(ram + a) : ram[a];
}
static inline void store(u32 a, u32 size, u32 v)
{
    if (size == 4) *(u32 *)(ram + a) = v;
    else if (size == 2) *(u16 *)(ram + a) = (u16)v;
    else ram[a] = (u8)v;
}
#endif

/* Whether an access of `size` bytes at `a` touches a page with any of `flags`. */
static inline u32 touches(u32 a, u32 size, u32 flags)
{
    u32 f = pageFlags[a >> 12];
    if ((a & 0xfff) > 0x1000 - size) f |= pageFlags[(a + size - 1) >> 12];
    return f & flags;
}

/* Whether the byte lies in a page's translated code, as the emitter's codeHit asks. */
static inline u32 codeHit(u32 a)
{
    if ((pageFlags[a >> 12] & HAS_CODE) == 0) return 0;
    u32 granule = (a & 0xfff) >> 5;
    u8 *range = codeRanges + (a >> 12) * 2;
    return granule >= range[0] && granule < range[1];
}

/*
 * The whole elements on the page of `a` from it the way a string instruction
 * goes: going up to the page's end, going down to its start, and none when
 * the element at `a` crosses the page's end.
 */
static inline u32 pageRoom(u32 a, u32 size, u32 down)
{
    u32 offset = a & 0xfff, shift = SIZE_INDEX(size);
    if (!down) return (0x1000 - offset) >> shift;
    return offset > 0x1000 - size ? 0 : (offset >> shift) + 1;
}

#ifdef LONG
/*
 * repeatBulk and passBulk below at long mode's widths: the pointers and the
 * count are quadwords, and a pointer at or past 2^32 is the element loop's,
 * which faults it. Within the window a run that stays on one page never
 * reaches 2^32, so the addresses are the 32-bit tier's.
 */
static u32 repeatBulk(u32 kind, u32 size, u32 down)
{
    u64 to64 = regs[7], from64 = regs[6], count = regs[1];
    if ((to64 >> 32) != 0 || (kind == 0xa4 && (from64 >> 32) != 0)) return 0;
    u32 to = (u32)to64, from = (u32)from64;
    u32 n = pageRoom(to, size, down);
    if (count < n) n = (u32)count;
    if (kind == 0xa4)
    {
        u32 room = pageRoom(from, size, down);
        if (room < n) n = room;
    }
    u32 bytes = n << SIZE_INDEX(size);
    if (n == 0 || (pageFlags[to >> 12] & (INACCESSIBLE | HAS_CODE | WATCH)) != 0) return 0;
    u32 low = down ? to + size - bytes : to;
    if (kind == 0xa4)
    {
        if ((pageFlags[from >> 12] & INACCESSIBLE) != 0
            || (down ? from - to : to - from) - 1 < bytes - 1) return 0;
        __builtin_memmove(ram + low, ram + (down ? from + size - bytes : from), bytes);
        regs[6] = down ? from64 - bytes : from64 + bytes;
    }
    else
    {
        u64 v = regOf(0, size, 0), b = v & 0xff;
        if (v == b * (MASKS[SIZE_INDEX(size)] / 0xff))
            __builtin_memset(ram + low, (int)b, bytes);
        else
            for (u32 a = low; a != low + bytes; a += size) store(a, size, v);
    }
    regs[7] = down ? to64 - bytes : to64 + bytes;
    regs[1] -= n;
    return n;
}

static void passBulk(u32 kind, u32 size, u32 down, u32 stopOnEqual)
{
    u64 to64 = regs[7], from64 = regs[6], count = regs[1];
    if ((to64 >> 32) != 0 || (kind == 0xa6 && (from64 >> 32) != 0)) return;
    u32 to = (u32)to64, from = (u32)from64;
    u32 n = pageRoom(to, size, down);
    if (count < n) n = (u32)count;
    if (kind == 0xa6)
    {
        u32 room = pageRoom(from, size, down);
        if (room < n) n = room;
    }
    if (n < 2 || (pageFlags[to >> 12] & INACCESSIBLE) != 0
        || (kind == 0xa6 && (pageFlags[from >> 12] & INACCESSIBLE) != 0)) return;
    u32 step = down ? (u32)-(i32)size : size, apart = from - to;
    u64 value = regOf(0, size, 0);
    u32 k = 0, a = to;
    for (; k < n - 1; k++, a += step)
    {
        u64 other = kind == 0xa6 ? load(a + apart, size) : value;
        if ((load(a, size) == other) == stopOnEqual) break;
    }
    u64 moved = (u64)k * size;
    regs[7] = down ? to64 - moved : to64 + moved;
    if (kind == 0xa6) regs[6] = down ? from64 - moved : from64 + moved;
    regs[1] -= k;
}
#else
/*
 * A `rep movs` (kind 0xa4) or `rep stos` (0xaa), as translated code runs one
 * (bulkString in emit/integer.js): every element that lies wholly on the
 * pointers' current pages the way DF goes at once, when the destination's
 * page is neither inaccessible nor holding translated code, the source's can
 * be read, and a copy's destination does not lie just ahead of its source the
 * way the copy goes, where the processor reads what it has just written and a
 * memmove does not. The registers move by the elements done, which is none
 * when any of that fails: the element is then the loop's own.
 */
static u32 repeatBulk(u32 kind, u32 size, u32 down)
{
    u32 to = regs[7], from = regs[6], n = regs[1];
    u32 room = pageRoom(to, size, down);
    if (room < n) n = room;
    if (kind == 0xa4)
    {
        room = pageRoom(from, size, down);
        if (room < n) n = room;
    }
    u32 bytes = n << SIZE_INDEX(size);
    if (n == 0 || (pageFlags[to >> 12] & (INACCESSIBLE | HAS_CODE | WATCH)) != 0) return 0;
    /* The run's lowest bytes: going down, the pointers less the bytes before
     * their own elements. */
    u32 low = down ? to + size - bytes : to;
    if (kind == 0xa4)
    {
        if ((pageFlags[from >> 12] & INACCESSIBLE) != 0
            || (down ? from - to : to - from) - 1 < bytes - 1) return 0;
        __builtin_memmove(ram + low, ram + (down ? from + size - bytes : from), bytes);
        regs[6] = down ? from - bytes : from + bytes;
    }
    else
    {
        u32 v = regOf(0, size), b = v & 0xff;
        if (v == (size == 4 ? b * 0x01010101u : size == 2 ? b * 0x0101u : b))
            __builtin_memset(ram + low, (int)b, bytes);
        else
            for (u32 a = low; a != low + bytes; a += size) store(a, size, v);
    }
    regs[7] = down ? to - bytes : to + bytes;
    regs[1] -= n;
    return n;
}

/*
 * A `repe`/`repne` `cmps` (kind 0xa6) or `scas` (0xae), as translated code
 * passes over one (bulkScan in emit/integer.js): the elements from the first
 * that do not stop it, among those that lie wholly on the pointers' current
 * pages the way DF goes, all but the last, when those pages can be read. The
 * registers move past them; the element after them is the loop's own, which
 * sets the flags.
 */
static void passBulk(u32 kind, u32 size, u32 down, u32 stopOnEqual)
{
    u32 to = regs[7], from = regs[6], n = regs[1];
    u32 room = pageRoom(to, size, down);
    if (room < n) n = room;
    if (kind == 0xa6)
    {
        room = pageRoom(from, size, down);
        if (room < n) n = room;
    }
    if (n < 2 || (pageFlags[to >> 12] & INACCESSIBLE) != 0
        || (kind == 0xa6 && (pageFlags[from >> 12] & INACCESSIBLE) != 0)) return;
    u32 step = down ? (u32)-(i32)size : size, apart = from - to, value = regOf(0, size);
    u32 k = 0, a = to;
    for (; k < n - 1; k++, a += step)
    {
        u32 other = kind == 0xa6 ? load(a + apart, size) : value;
        if ((load(a, size) == other) == stopOnEqual) break;
    }
    regs[7] = to + k * step;
    if (kind == 0xa6) regs[6] = from + k * step;
    regs[1] -= k;
}
#endif

/* A condition code of the flags word. */
static inline u32 holds(u32 cc, u32 f)
{
    u32 h;
    switch (cc >> 1)
    {
    case 0: h = (f & OF) != 0; break;
    case 1: h = (f & CF) != 0; break;
    case 2: h = (f & ZF) != 0; break;
    case 3: h = (f & (CF | ZF)) != 0; break;
    case 4: h = (f & SF) != 0; break;
    case 5: h = (f & PF) != 0; break;
    case 6: h = ((f & SF) != 0) != ((f & OF) != 0); break;
    default: h = (f & ZF) != 0 || ((f & SF) != 0) != ((f & OF) != 0); break;
    }
    return (cc & 1) ? !h : h;
}

#ifdef LONG
static inline u32 resultFlags(u64 r, u32 si)
{
    return (r == 0 ? ZF : 0) | ((r & SIGNS[si]) ? SF : 0) | (PARITY[r & 0xff] ? PF : 0);
}
#else
static inline u32 resultFlags(u32 r, u32 si)
{
    return (r == 0 ? ZF : 0) | ((r & SIGNS[si]) ? SF : 0) | (PARITY[r & 0xff] ? PF : 0);
}
#endif

/* The lazy record's kinds; the record's kind word is kind << 2 | size index. */
enum { L_ADD = 1, L_ADC, L_SUB, L_SBB, L_LOGIC, L_INC, L_DEC };

#ifdef LONG

/* The record folded at long mode's widths, where no wider type holds a quadword's
 * carry: an add carried when its result came out below its first operand (or at
 * it, with a carry in), a subtract borrowed when the second operand and the
 * borrow in passed the first. */
#define FOLD() do { if (lk) { \
        u32 _s = lk & 3, _f; \
        u64 _m = MASKS[_s], _sg = SIGNS[_s], _r = lr & _m, _a = la & _m, _b = lb & _m; \
        switch (lk >> 2) \
        { \
        case L_ADD: case L_ADC: \
            _f = ((lc ? _r <= _a : _r < _a) ? CF : 0) | ((((_a ^ _r) & (_b ^ _r)) & _sg) ? OF : 0) \
                | (((_a ^ _b ^ _r) & 0x10) ? AF : 0); break; \
        case L_SUB: case L_SBB: \
            _f = ((_a < _b || (lc && _a == _b)) ? CF : 0) | ((((_a ^ _b) & (_a ^ _r)) & _sg) ? OF : 0) \
                | (((_a ^ _b ^ _r) & 0x10) ? AF : 0); break; \
        case L_INC: \
            _f = (fl & CF) | ((((_a ^ _r) & (1 ^ _r)) & _sg) ? OF : 0) | (((_a ^ 1 ^ _r) & 0x10) ? AF : 0); break; \
        case L_DEC: \
            _f = (fl & CF) | ((((_a ^ 1) & (_a ^ _r)) & _sg) ? OF : 0) | (((_a ^ 1 ^ _r) & 0x10) ? AF : 0); break; \
        default: _f = 0; break; \
        } \
        fl = (fl & ~ARITH) | _f | resultFlags(_r, _s); lk = 0; } } while (0)
#else
/* The last flag writer, the record run keeps, folded into the flags word. */
#define FOLD() do { if (lk) { \
        u32 _s = lk & 3, _m = MASKS[_s], _sg = SIGNS[_s]; \
        u32 _r = lr & _m, _a = la & _m, _b = lb & _m, _f; \
        switch (lk >> 2) \
        { \
        case L_ADD: case L_ADC: \
            _f = ((u64)_a + _b + lc > _m ? CF : 0) | ((((_a ^ _r) & (_b ^ _r)) & _sg) ? OF : 0) \
                | (((_a ^ _b ^ _r) & 0x10) ? AF : 0); break; \
        case L_SUB: case L_SBB: \
            _f = ((u64)_a < (u64)_b + lc ? CF : 0) | ((((_a ^ _b) & (_a ^ _r)) & _sg) ? OF : 0) \
                | (((_a ^ _b ^ _r) & 0x10) ? AF : 0); break; \
        case L_INC: \
            _f = (fl & CF) | ((((_a ^ _r) & (1 ^ _r)) & _sg) ? OF : 0) | (((_a ^ 1 ^ _r) & 0x10) ? AF : 0); break; \
        case L_DEC: \
            _f = (fl & CF) | ((((_a ^ 1) & (_a ^ _r)) & _sg) ? OF : 0) | (((_a ^ 1 ^ _r) & 0x10) ? AF : 0); break; \
        default: _f = 0; break; \
        } \
        fl = (fl & ~ARITH) | _f | resultFlags(_r, _s); lk = 0; } } while (0)
#endif

/*
 * x87, as ir-x87.js models it and in its order of effects -- the reference
 * the hardware corpus judges and the translated code follows: the registers
 * doubles, ST(i) the physical register (top + i) & 7, the stack faults with
 * IE and SF, C1 on a push, precision control's single rounding, a NaN an
 * operation makes the processor's negative one, and the sticky IE, ZE and UE
 * where the model raises them. Unless `precise`, as translated code does
 * then, the sticky IE, ZE and UE are not raised (a stack fault's IE and SF
 * are), a signalling NaN loaded is not seen as one, and C1 is left as it was
 * by a push that did not overflow and by fcomi: their tests were some six per
 * cent of an x87 transform loop's time here. The transcendentals are the
 * host's `Math`, imported as translated code imports them, so the three
 * agree; the partial remainder is the model's in integers, as translated
 * code's shared helper computes it (`remainderOf`). A quadword fild's
 * integer is kept beside the double it rounds to, for a quadword fistp or
 * fisttp of it to store the eight bytes whole (exactWrites in ir-x87.js).
 * What it leaves to the JavaScript tier: the environment and save images
 * (fldenv, fnstenv, frstor, fnsave) and packed BCD.
 */
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))
IMPORT("sin") double hostSin(double);
IMPORT("cos") double hostCos(double);
IMPORT("tan") double hostTan(double);
IMPORT("atan2") double hostAtan2(double, double);
IMPORT("expm1") double hostExpm1(double);
IMPORT("log2") double hostLog2(double);
IMPORT("log1p") double hostLog1p(double);

#define S_IE 0x1u
#define S_ZE 0x4u
#define S_UE 0x10u
#define S_SF 0x40u
#define S_C0 0x100u
#define S_C1 0x200u
#define S_C2 0x400u
#define S_C3 0x4000u
#define S_CONDITION (S_C0 | S_C1 | S_C2 | S_C3)
#define SIGN64 0x8000000000000000ull
#define INDEFINITE_BITS 0xfff8000000000000ull
/* The host's NaN, which a load of an extended NaN gives as the model's does. */
#define HOST_NAN_BITS 0x7ff8000000000000ull

typedef union { double d; u64 u; u32 w[2]; } F64;
typedef union { float f; u32 u; } F32;

static inline u64 bitsOf(double d) { F64 v; v.d = d; return v.u; }
static inline double fromBits(u64 u) { F64 v; v.u = u; return v.d; }
static inline u32 isNaN(double d) { return d != d; }
static inline u32 signalling(double d) { return isNaN(d) && (bitsOf(d) & (1ull << 51)) == 0; }
/* 2^k for k in [-1022, 1023], exactly. */
static inline double pow2(i32 k) { return fromBits((u64)(k + 1023) << 52); }
static inline i32 clampInt(i32 v, i32 lo, i32 hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline double clampF(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Single precision control (PC 00): the double rounded to 24 bits, nearest even,
 * in its own bits so the exponent range stays wide. */
static inline double byPrecision(double v, u32 control)
{
    if (control & 0x300) return v;
    F64 f;
    f.d = v;
    if ((f.w[1] & 0x7ff00000) == 0x7ff00000) return v;
    u64 sum = (u64)f.w[0] + ((f.w[0] >> 29) & 1) + 0x0fffffff;
    f.w[0] = (u32)sum & 0xe0000000;
    f.w[1] += sum >= 0x100000000ull ? 1 : 0;
    return f.d;
}

/* A NaN made from operands that were none carries the sign the processor's has. */
static inline double hostNaN(double v, double a, double c)
{
    return isNaN(v) && !isNaN(a) && !isNaN(c) ? fromBits(bitsOf(v) | SIGN64) : v;
}

/* fprem (nearest 0) and fprem1 of a finite a by a nonzero c that is not a NaN:
 * the exact remainder, and in *bits C2 for a partial reduction or else the
 * quotient's low three bits in C0, C3 and C1 -- the model's `remainder` and
 * translated code's `addRemainderHelper` (emit/x87.js), the same long division
 * of the significands eleven bits a step, past a difference of 63 by the divisor
 * times a power of two that leaves 32 plus the difference mod 32 of it. */
static double remainderOf(double a, double c, u32 nearest, u32 *bits)
{
    if (a == 0 || __builtin_fabs(c) == __builtin_inf())
    {
        *bits = 0;
        return a;
    }
    u64 ma = bitsOf(a) & 0xfffffffffffffull, mc = bitsOf(c) & 0xfffffffffffffull;
    i32 ea = (i32)(bitsOf(a) >> 52 & 0x7ff), ec = (i32)(bitsOf(c) >> 52 & 0x7ff);
    if (ea == 0)
    {
        i32 shift = __builtin_clzll(ma) - 11;
        ma <<= shift;
        ea = -1022 - shift;
    }
    else
    {
        ma |= 1ull << 52;
        ea -= 1023;
    }
    if (ec == 0)
    {
        i32 shift = __builtin_clzll(mc) - 11;
        mc <<= shift;
        ec = -1022 - shift;
    }
    else
    {
        mc |= 1ull << 52;
        ec -= 1023;
    }
    i32 n = ea - ec;
    if (n < 0)
    {
        /* fprem1's quotient of a dividend past half the divisor rounds to 1. */
        if (nearest && n == -1 && __builtin_fabs(a) * 2 > __builtin_fabs(c))
        {
            *bits = S_C1;
            return a - __builtin_copysign(__builtin_fabs(c), a);
        }
        *bits = 0;
        return a;
    }
    u32 partial = n >= 64;
    if (partial) n = 32 + (n & 31);
    i32 e = ea - n - 52;
    u32 q = 0;
    do
    {
        i32 k = n < 11 ? n : 11;
        ma <<= k;
        u64 step = ma / mc;
        q = ((q << k) + (u32)step) & 7;
        ma -= step * mc;
        n -= k;
    } while (n > 0);
    if (nearest && !partial && (ma * 2 > mc || (ma * 2 == mc && (q & 1))))
    {
        ma = mc - ma;
        q = (q + 1) & 7;
        a = -a;
    }
    i32 k = e > -1022 ? e : -1022;
    *bits = partial ? S_C2 : ((q & 4) ? S_C0 : 0) | ((q & 2) ? S_C3 : 0) | ((q & 1) ? S_C1 : 0);
    return __builtin_copysign((double)ma * pow2(k) * pow2(e - k), a);
}

/* The host's log2 and log1p of a negative NaN are signalling NaNs, which the call
 * back from JavaScript quiets on some engines: quieted here whatever the engine. */
static inline double quietNaN(double v) { return isNaN(v) ? fromBits(bitsOf(v) | 1ull << 51) : v; }

/* Two NaN operands give the x87's choice, as the model's twoNaN: a quiet one over
 * a signalling one, then the larger significand, then the positive, quieted. */
static inline double twoNaN(double v, double a, double c)
{
    if (!isNaN(a) || !isNaN(c)) return v;
    u64 ba = bitsOf(a), bc = bitsOf(c), fa = ba & 0xfffffffffffffull, fc = bc & 0xfffffffffffffull, pick;
    if (signalling(a) != signalling(c)) pick = signalling(a) ? bc : ba;
    else if (fa != fc) pick = fa > fc ? ba : bc;
    else pick = (ba >> 63) ? bc : ba;
    return fromBits(pick | 1ull << 51);
}

/* Rounding by the control word's RC, nearest ties to even as the model computes it. */
static double roundBy(double v, u32 control)
{
    if (isNaN(v) || v - v != 0 || v == 0) return v;
    u32 mode = (control >> 10) & 3;
    if (mode == 1) return __builtin_floor(v);
    if (mode == 2) return __builtin_ceil(v);
    if (mode == 3) return __builtin_trunc(v);
    double low = __builtin_floor(v), diff = v - low;
    double r = diff < 0.5 ? low
        : diff > 0.5 || __builtin_floor(low * 0.5) * 2 != low ? low + 1 : low;
    /* A negative rounded to zero is -0, as the processor's is; -1 + 1 is +0. */
    return __builtin_copysign(r, v);
}

/* The ten-byte extended value as a double, as the model's conversion has it: a
 * NaN keeps its payload's top 52 bits (by its lowest bit when they are all clear),
 * a zero its sign. */
static double f80ToF64(u64 low, u32 high)
{
    if ((high & 0x7fff) == 0x7fff)
    {
        u64 fraction = (low >> 11) & 0x000fffffffffffffull;
        u64 special = (low & ~SIGN64) == 0 ? 0x7ff0000000000000ull
            : 0x7ff0000000000000ull | (fraction ? fraction : 1);
        return fromBits(special | (u64)(high & 0x8000) << 48);
    }
    if (low == 0) return fromBits((u64)(high & 0x8000) << 48);
    double v = (double)low;
    i32 e = (i32)(high & 0x7fff) - 16446;
    for (u32 pass = 0; pass < 2; pass++)
    {
        i32 k = clampInt(e, -1022, 1023);
        v *= pow2(k);
        e -= k;
    }
    return (high & 0x8000) ? -v : v;
}

static void writeF80(u32 at, double v)
{
    u64 word = bitsOf(v), fraction = word & 0x000fffffffffffffull, mantissa;
    u32 rawExponent = (u32)(word >> 52) & 0x7ff, signExponent = (u32)(word >> 63) << 15;
    if (rawExponent == 0x7ff)
    {
        mantissa = fraction << 11 | SIGN64;
        signExponent |= 0x7fff;
    }
    else if (rawExponent == 0 && fraction == 0) mantissa = 0;
    else if (rawExponent == 0)
    {
        u32 count = (u32)__builtin_clzll(fraction);
        mantissa = fraction << count;
        signExponent |= 15372 - count;
    }
    else
    {
        mantissa = fraction << 11 | SIGN64;
        signExponent |= rawExponent + 15360;
    }
    *(u64 *)(ram + at) = mantissa;
    *(u16 *)(ram + at + 8) = (u16)signExponent;
}

/* How the x87 helper ended: done, left unexecuted, faulted (#GP), or done with
 * the arithmetic flags in xFlags (fcomi). */
enum { X_DONE = 0, X_LEAVE, X_FAULT, X_FLAGS };
static u32 xFlags;
/* A store into translated code, for the run to end after it. */
static u32 xWrite;
static u32 xWriteSize;
/* The physical registers holding a quadword fild's integer, unwritten since, and
 * the integers. Taken from the block at every run's start and left there at its
 * end, where the JavaScript interpreter keeps its own and translated code takes
 * the marks off the registers it writes: a run may end between the load and the
 * store. With no place in the block (exactAt null) they are dropped instead. */
static u32 exactMarks;
static i64 exactShadow[8];

static void exactIn(void)
{
    exactMarks = exactAt ? *exactAt : 0;
    for (u32 i = 0; i < 8; i++)
        if ((exactMarks >> i) & 1) exactShadow[i] = *(i64 *)(x87Regs + i * 16 + 8);
}

static void exactOut(void)
{
    if (!exactAt) return;
    *exactAt = (u8)exactMarks;
    for (u32 i = 0; i < 8; i++)
        if ((exactMarks >> i) & 1) *(i64 *)(x87Regs + i * 16 + 8) = exactShadow[i];
}

/* The stack-fault check: t1 when a source ST(i) -- a bit per i in `sources` --
 * is empty or a push finds its register held, raising IE and SF; a push sets
 * C1 when it overflowed and clears it when not, an underflow otherwise clears
 * it. */
static inline u32 guard(u32 top, u32 empty, u32 *status, u32 sources, u32 pushes)
{
    u32 read = ((sources << top) | (sources >> (8 - top))) & 0xff;
    u32 t1 = (empty & read) != 0;
    if (t1) *status &= ~S_C1;
    if (pushes)
    {
        u32 held = ((empty >> ((top - 1) & 7)) & 1) == 0;
        /* An underflow of the source comes first: C1 says nothing of the push then. */
        u32 under = (empty & read) != 0;
        t1 |= held;
        if (held && !under) *status |= S_C1;
        else if (precise) *status &= ~S_C1;
    }
    if (t1) *status |= S_IE | S_SF;
    return t1;
}

/* C3 C2 C0 of a compare, C1 cleared; ordered (fcom) raises IE on any NaN,
 * unordered (fucom) on a signalling one. */
static inline u32 compareBits(u32 status, double a, double c, u32 ordered, u32 t1)
{
    status &= ~S_CONDITION;
    if (isNaN(a) || isNaN(c) || t1)
    {
        status |= S_C3 | S_C2 | S_C0;
        if (precise && (ordered || signalling(a) || signalling(c))) status |= S_IE;
    }
    else
    {
        if (a == c) status |= S_C3;
        if (a < c) status |= S_C0;
    }
    return status;
}

/* ST(target) op source, the operation by the /r of D8: 0 add, 1 mul, 4 sub,
 * 5 subr, 6 div, 7 divr. */
static inline double arith(u32 kind, double a0, double c0, u32 t1, u32 control, u32 *status)
{
    u32 reversed = kind == 5 || kind == 7;
    double a = reversed ? c0 : a0, c = reversed ? a0 : c0, r;
    switch (kind)
    {
    case 0: r = a + c; break;
    case 1: r = a * c; break;
    case 4: case 5: r = a - c; break;
    default: r = a / c; break;
    }
    r = twoNaN(hostNaN(byPrecision(r, control), a0, c0), a0, c0);
    if (t1) return fromBits(INDEFINITE_BITS);
    if (!precise) return r;
    if (kind >= 6 && c == 0 && a != 0 && __builtin_fabs(a) < __builtin_inf()) *status |= S_ZE;
    /* A NaN made of operands that were not, or a register that held a signalling one. */
    if (isNaN(r) && ((!isNaN(a0) && !isNaN(c0)) || signalling(a0) || signalling(c0))) *status |= S_IE;
    return r;
}

static inline double loadF32(u32 at, u32 *status)
{
    F32 v;
    v.u = *(u32 *)(ram + at);
    if (precise && (v.u & 0x7fffffff) > 0x7f800000 && (v.u & 0x400000) == 0)
    {
        *status |= S_IE;
        v.u |= 0x400000;
    }
    return (double)v.f;
}

static inline double loadF64(u32 at, u32 *status)
{
    u32 low = *(u32 *)(ram + at), high = *(u32 *)(ram + at + 4), h = high & 0x7fffffff;
    if (precise && (h > 0x7ff00000 || (h == 0x7ff00000 && low != 0)) && (h & 0x80000) == 0)
    {
        *status |= S_IE;
        high |= 0x80000;
    }
    return fromBits((u64)high << 32 | low);
}

#define REG(p) (*(double *)(x87Regs + ((p) & 7) * 16))
#define ST(k) REG(top + (k))
#define PHYS(k) ((top + (k)) & 7)
#define GUARD(sources, pushes) guard(top, empty, &status, (sources), (pushes))
#define OR_INDEFINITE(v, t1) ((t1) ? fromBits(INDEFINITE_BITS) : (v))
/* Writes ST(k), which is held after it: an instruction whose source was empty
 * writes the indefinite there, and the register is held, as the processor
 * tags it. */
#define SET_ST(k, v) do { double _s = (v); u32 _p = PHYS(k); REG(_p) = _s; \
        empty &= ~(1u << _p); } while (0)
/* A push writes the register it lands in, a pop drops the one it frees: the
 * registers an exact integer no longer holds (xw, xp). */
#define PUSH_ST(v) do { double _v = (v); top = (top - 1) & 7; xw |= 1u << top; REG(top) = _v; \
        empty &= ~(1u << top); } while (0)
#define POP_ST() do { xp |= 1u << top; empty |= 1u << top; top = (top + 1) & 7; } while (0)
#ifdef LONG
/* The whole address of the helper's memory operand, whose low half `ea` is: an
 * access that reaches 2^32 lies outside the window. */
static u64 eaWide;
#define X_WINDOW(size) do { if (eaWide > WINDOW - (size)) { code = X_FAULT; goto done; } } while (0)
#else
#define X_WINDOW(size) do { } while (0)
#endif
#define X_READ(a, size) do { X_WINDOW(size); \
        if (touches((a), (size), INACCESSIBLE)) { code = X_FAULT; goto done; } } while (0)
#define X_WRITE(a, size) do { u32 _a = (a); X_WINDOW(size); \
        if (touches(_a, (size), INACCESSIBLE | HAS_CODE | WATCH)) \
        { \
            if (touches(_a, (size), INACCESSIBLE)) { code = X_FAULT; goto done; } \
            if (touches(_a, (size), WATCH)) { code = X_LEAVE; goto done; } \
            if (codeHit(_a) || codeHit(_a + (size) - 1)) { xWrite = _a; xWriteSize = (size); } \
        } } while (0)

#ifdef LONG
/* The REX byte of the instruction a helper runs, as `prefixed` found it, and
 * whether it has the address-size prefix. */
static u32 xRex;
static u32 xAddr32;

/* The memory operand of the modrm byte at p[*at], below 0xc0, in long mode:
 * REX.B and REX.X reach the further registers, mod 00 rm 101 is RIP-relative
 * from the instruction's end -- `extra` immediate bytes past its addressing
 * bytes -- and the segment's base is added last, to an address the
 * address-size prefix cut to 32 bits. Its low half is answered, the whole in
 * eaWide. */
static inline u32 memoryOperand(const u8 *p, u32 *at, u64 seg, u32 extra)
{
    u32 len = *at, modrm = p[len++], mod = modrm >> 6, rm = modrm & 7, b = (xRex & 1) << 3;
    u64 ea;
    if (rm == 4)
    {
        u32 sib = p[len++], index = ((sib >> 3) & 7) | ((xRex & 2) << 2);
        ea = index != 4 ? regs[index] << (sib >> 6) : 0;
        if ((sib & 7) == 5 && mod == 0)
        {
            ea += (u64)(i64)*(i32 *)(p + len);
            len += 4;
        }
        else ea += regs[(sib & 7) | b];
    }
    else if (rm == 5 && mod == 0)
    {
        ea = (u64)(i64)*(i32 *)(p + len);
        len += 4;
        ea += (u64)(u32)(p - ram) + len + extra;
    }
    else ea = regs[rm | b];
    if (mod == 1)
    {
        ea += (u64)(i64)(i8)p[len];
        len += 1;
    }
    else if (mod == 2)
    {
        ea += (u64)(i64)*(i32 *)(p + len);
        len += 4;
    }
    if (xAddr32) ea = (u32)ea;
    *at = len;
    eaWide = ea + seg;
    return (u32)eaWide;
}
#else
/* The memory operand of the modrm byte at p[*at], below 0xc0: its address with
 * the segment's base; *at moves past the modrm and its addressing bytes. */
static inline u32 memoryOperand(const u8 *p, u32 *at, u32 seg)
{
    u32 len = *at, modrm = p[len++], mod = modrm >> 6, rm = modrm & 7, ea;
    if (rm == 4)
    {
        u32 sib = p[len++], base = sib & 7, index = (sib >> 3) & 7;
        ea = index != 4 ? regs[index] << (sib >> 6) : 0;
        if (base == 5 && mod == 0)
        {
            ea += *(u32 *)(p + len);
            len += 4;
        }
        else ea += regs[base];
    }
    else if (rm == 5 && mod == 0)
    {
        ea = *(u32 *)(p + len);
        len += 4;
    }
    else ea = regs[rm];
    if (mod == 1)
    {
        ea += (u32)(i32)(i8)p[len];
        len += 1;
    }
    else if (mod == 2)
    {
        ea += *(u32 *)(p + len);
        len += 4;
    }
    *at = len;
    return ea + seg;
}
#endif

/* The whole length of the instruction a helper ran. */
static u32 xLen;

#ifdef LONG
/* `prefixed` below in long mode: GS has a base too, ES, CS, SS and DS have
 * none, and a REX byte counts only right before the opcode (in xRex). */
static inline u32 prefixed(const u8 *p, u32 *at, u64 *seg, u32 *key, u32 *lock)
{
    u32 len = 0, operand = 0, rep = 0, rex = 0, op;
    *seg = 0;
    *lock = 0;
    xAddr32 = 0;
    for (;;)
    {
        op = p[len++];
        if ((op & 0xf0) == 0x40)
        {
            rex = op;
            continue;
        }
        if (op == 0x66) operand = 1;
        else if (op == 0x67) xAddr32 = 1;
        else if (op == 0x64) *seg = *fsBaseField;
        else if (op == 0x65) *seg = *gsBaseField;
        else if (op == 0xf3) rep = 1;
        else if (op == 0xf2) rep = 2;
        else if (op == 0xf0) *lock = 1;
        else if (op != 0x26 && op != 0x2e && op != 0x36 && op != 0x3e) break;
        rex = 0;
    }
    xRex = rex;
    eaWide = 0;
    *key = rep == 1 ? 2 : rep == 2 ? 3 : operand;
    *at = len;
    return op;
}
#define MEMORY_OPERAND(p, at, seg, extra) memoryOperand((p), (at), (seg), (extra))
typedef u64 SegmentBase;
#else
#define MEMORY_OPERAND(p, at, seg, extra) memoryOperand((p), (at), (seg))
typedef u32 SegmentBase;

/* The prefixes of the instruction at p as run takes them -- fs's base, the
 * mandatory prefix key (0 none, 1 66, 2 F3, 3 F2, the repeats first as the
 * decoder picks them) and lock -- and its opcode byte, *at past it. A helper
 * takes them again rather than from run: see x87. */
static inline u32 prefixed(const u8 *p, u32 *at, u32 *seg, u32 *key, u32 *lock)
{
    u32 len = 0, operand = 0, rep = 0, op;
    *seg = 0;
    *lock = 0;
    for (;;)
    {
        op = p[len++];
        if (op == 0x66) operand = 1;
        else if (op == 0x64) *seg = *fsBaseField;
        else if (op == 0xf3) rep = 1;
        else if (op == 0xf2) rep = 2;
        else if (op == 0xf0) *lock = 1;
        else if (op != 0x26 && op != 0x2e && op != 0x36 && op != 0x3e) break;
    }
    *key = rep == 1 ? 2 : rep == 2 ? 3 : operand;
    *at = len;
    return op;
}
#endif

/* Set while the flags word in the block is exact -- the lazy record run keeps
 * folded into it -- which only fcmov reads; and set by the helper when an
 * X_LEAVE is an fcmov that needs it so. */
static u32 xFlagsExact;
static u32 xNeedsFlags;

/*
 * One x87 instruction, at p. The decoding is here, prefixes and all, and the
 * call takes nothing else of run's: passing the lazy flag record, the word, the
 * prefixes run decoded or the modrm's address as arguments, folding the record
 * for the call, or decoding the modrm in run each made run's integer paths two
 * to ten per cent slower in TurboFan. An fcmov met in run is left, with
 * xNeedsFlags set, and the wrapper runs it once run has folded its record on
 * the way out. Nothing runs before a form is known to be modelled, so X_LEAVE
 * leaves the state as it was; a fault may follow a stack fault's IE and SF,
 * as in the model.
 */
__attribute__((noinline))
static u32 x87(const u8 *p)
{
    SegmentBase seg;
    u32 len, key, lock, escape = prefixed(p, &len, &seg, &key, &lock);
    if (key >= 2 || lock) return X_LEAVE;
    u32 top = *x87TopAt & 7, empty = *x87EmptyAt, status = *x87StatusAt, control = *x87ControlAt;
    u32 modrm = p[len], ea = 0;
    if (modrm < 0xc0) ea = MEMORY_OPERAND(p, &len, seg, 0);
    else len += 1;
    xLen = len;
    xWrite = NONE;
    u32 code = X_DONE, e = escape & 7, g = (modrm >> 3) & 7, i = modrm & 7, t1, pops = 0;
    /* What the instruction does to the exact integers, as exactWrites has it: the
     * registers it writes and pops, the ones it made exact, and whether it is a
     * form after which none is. */
    u32 xw = 0, xp = 0, xm = 0, xnone = 0;
    if (modrm < 0xc0)
    {
        switch (e << 3 | g)
        {
        /* fadd fmul fcom fcomp fsub fsubr fdiv fdivr: m32fp, m32int, m64fp, m16int */
        case 000: case 001: case 002: case 003: case 004: case 005: case 006: case 007:
        case 020: case 021: case 022: case 023: case 024: case 025: case 026: case 027:
        case 040: case 041: case 042: case 043: case 044: case 045: case 046: case 047:
        case 060: case 061: case 062: case 063: case 064: case 065: case 066: case 067:
        {
            double c0;
            t1 = GUARD(1, 0);
            if (e == 0) { X_READ(ea, 4); c0 = loadF32(ea, &status); }
            else if (e == 4) { X_READ(ea, 8); c0 = loadF64(ea, &status); }
            else if (e == 2) { X_READ(ea, 4); c0 = (double)*(i32 *)(ram + ea); }
            else { X_READ(ea, 2); c0 = (double)*(i16 *)(ram + ea); }
            if (g == 2 || g == 3)
            {
                status = compareBits(status, ST(0), c0, 1, t1);
                if (g == 3) POP_ST();
            }
            else
            {
                SET_ST(0, arith(g, ST(0), c0, t1, control, &status));
                xw = 1u << top;
            }
            break;
        }
        case 010: case 050: case 035:
        {
            /* fld m32fp, m64fp, m80fp */
            double v;
            if (e == 1) { X_READ(ea, 4); v = loadF32(ea, &status); }
            else if (e == 5) { X_READ(ea, 8); v = loadF64(ea, &status); }
            else
            {
                X_READ(ea, 10);
                u32 high = *(u16 *)(ram + ea + 8);
                u64 low = *(u64 *)(ram + ea);
                /* No IE for a signalling NaN in this format (the SDM's FLD). */
                v = f80ToF64(low, high);
            }
            t1 = GUARD(0, 1);
            PUSH_ST(OR_INDEFINITE(v, t1));
            break;
        }
        case 030: case 070: case 075:
        {
            /* fild m32int, m16int, m64int */
            double v;
            if (e == 3) { X_READ(ea, 4); v = (double)*(i32 *)(ram + ea); }
            else if (g == 0) { X_READ(ea, 2); v = (double)*(i16 *)(ram + ea); }
            else { X_READ(ea, 8); v = (double)*(i64 *)(ram + ea); }
            t1 = GUARD(0, 1);
            PUSH_ST(OR_INDEFINITE(v, t1));
            if (g == 5 && !t1)
            {
                exactShadow[top] = *(i64 *)(ram + ea);
                xm = 1u << top;
            }
            break;
        }
        case 012: case 013: case 052: case 053: case 037:
        {
            /* fst, fstp m32fp, m64fp; fstp m80fp: a signalling NaN stored to a single
             * or a double raises IE and goes out quiet, the extended takes it as it is. */
            double v = OR_INDEFINITE(ST(0), GUARD(1, 0));
            if ((e == 1 || e == 5) && signalling(v))
            {
                if (precise) status |= S_IE;
                v = fromBits(bitsOf(v) | 0x0008000000000000ull);
            }
            if (e == 1)
            {
                if (precise && __builtin_fabs(v) < 0x1p-126 && v != 0) status |= S_UE;
                X_WRITE(ea, 4);
                F32 f;
                f.f = (float)v;
                *(u32 *)(ram + ea) = f.u;
            }
            else if (e == 5)
            {
                X_WRITE(ea, 8);
                *(u64 *)(ram + ea) = bitsOf(v);
            }
            else
            {
                X_WRITE(ea, 10);
                writeF80(ea, v);
            }
            if (g != 2) POP_ST();
            break;
        }
        case 031: case 032: case 033: case 051: case 071: case 072: case 073: case 077:
        {
            /* fisttp, fist, fistp: the value rounded by RC (fisttp truncated) to the
             * operand's width; a NaN or one out of range stores the integer
             * indefinite and raises IE. */
            u32 size = e == 3 ? 4 : e == 5 || g == 7 ? 8 : 2;
            t1 = GUARD(1, 0);
            double v = OR_INDEFINITE(ST(0), t1);
            double r = g == 1 ? __builtin_trunc(v) : roundBy(v, control);
            double limit = size == 2 ? 32768.0 : size == 4 ? 2147483648.0 : 9223372036854775808.0;
            u64 bits;
            /* An exact integer is itself, in range and needing no rounding; the
             * compare is a second guard on what the marks promise. */
            if (size == 8 && !t1 && ((exactMarks >> top) & 1) && v == (double)exactShadow[top])
                bits = (u64)exactShadow[top];
            else if (!(r >= -limit && r < limit))
            {
                if (precise) status |= S_IE;
                bits = size == 8 ? SIGN64 : size == 4 ? 0x80000000u : 0x8000u;
            }
            else bits = (u64)(i64)r;
            X_WRITE(ea, size);
            if (size == 8) *(u64 *)(ram + ea) = bits;
            else if (size == 4) *(u32 *)(ram + ea) = (u32)bits;
            else *(u16 *)(ram + ea) = (u16)bits;
            if (g != 2) POP_ST();
            break;
        }
        case 015:
            X_READ(ea, 2);
            control = *(u16 *)(ram + ea);
            break;
        case 017:
            X_WRITE(ea, 2);
            *(u16 *)(ram + ea) = (u16)control;
            break;
        case 057:
            X_WRITE(ea, 2);
            *(u16 *)(ram + ea) = (u16)((status & ~0x3800u) | top << 11);
            relaxedReads += !precise;
            break;
        default:
            code = X_LEAVE;
            break;
        }
        goto done;
    }
    switch (e)
    {
    case 0:
        /* D8: op ST0, ST(i) */
        t1 = GUARD(1 | 1u << i, 0);
        if (g == 2 || g == 3)
        {
            status = compareBits(status, ST(0), ST(i), 1, t1);
            if (g == 3) POP_ST();
        }
        else
        {
            SET_ST(0, arith(g, ST(0), ST(i), t1, control, &status));
            xw = 1u << top;
        }
        break;
    case 4: case 6:
        /* DC: op ST(i), ST0, the subtract and divide senses reversed against D8;
         * DE: the same, popping. DC D0+i, D8+i and DE D0+i are fcom, fcomp and
         * fcomp st(i); DE D9 is fcompp. */
        if (g == 3 && e == 6)
        {
            if (i != 1)
            {
                code = X_LEAVE;
                break;
            }
            t1 = GUARD(3, 0);
            status = compareBits(status, ST(0), ST(1), 1, t1);
            POP_ST();
            POP_ST();
            break;
        }
        t1 = GUARD(1 | 1u << i, 0);
        if (g == 2 || g == 3)
        {
            status = compareBits(status, ST(0), ST(i), 1, t1);
            if (g == 3 || e == 6) POP_ST();
            break;
        }
        SET_ST(i, arith(g >= 4 ? g ^ 1 : g, ST(i), ST(0), t1, control, &status));
        xw = 1u << PHYS(i);
        if (e == 6) POP_ST();
        break;
    case 1:
        if (modrm < 0xc8)
        {
            double v = ST(i);
            u32 from = PHYS(i);
            t1 = GUARD(1u << i, 1);
            PUSH_ST(OR_INDEFINITE(v, t1));
            if (!t1 && ((exactMarks >> from) & 1))
            {
                exactShadow[top] = exactShadow[from];
                xm = 1u << top;
            }
            break;
        }
        if (modrm < 0xd0) goto fxch;
        if (modrm == 0xd0) break;
        if (modrm < 0xd8)
        {
            code = X_LEAVE;
            break;
        }
        if (modrm < 0xe0)
        {
            pops = 1;
            goto storeRegister;
        }
        /* ftst, fxam and the constants keep the exact integers; the rest of D9 E0-FF
         * write or move the stack otherwise. */
        xnone = modrm != 0xe4 && modrm != 0xe5 && (modrm < 0xe8 || modrm > 0xee);
        switch (modrm)
        {
        /* fchs and fabs clear C1, as fxch, fincstp and fdecstp do. */
        case 0xe0:
        {
            double v = -ST(0);
            SET_ST(0, OR_INDEFINITE(v, GUARD(1, 0)));
            status &= ~S_C1;
            break;
        }
        case 0xe1:
        {
            double v = __builtin_fabs(ST(0));
            SET_ST(0, OR_INDEFINITE(v, GUARD(1, 0)));
            status &= ~S_C1;
            break;
        }
        case 0xe4:
            t1 = GUARD(1, 0);
            status = compareBits(status, ST(0), 0, 1, t1);
            break;
        case 0xe5:
        {
            double v = ST(0);
            status &= ~S_CONDITION;
            /* The sign of what the register holds, empty or not. */
            if (bitsOf(v) >> 63) status |= S_C1;
            if ((empty >> top) & 1) status |= S_C3 | S_C0;
            else if (isNaN(v)) status |= S_C0;
            else if (__builtin_fabs(v) == __builtin_inf()) status |= S_C2 | S_C0;
            else if (v == 0) status |= S_C3;
            else status |= S_C2;
            break;
        }
        case 0xe8: case 0xe9: case 0xea: case 0xeb: case 0xec: case 0xed: case 0xee:
        {
            static const u64 CONSTANTS[7] = {
                0x3ff0000000000000ull, 0x400a934f0979a371ull, 0x3ff71547652b82feull,
                0x400921fb54442d18ull, 0x3fd34413509f79ffull, 0x3fe62e42fefa39efull, 0,
            };
            t1 = GUARD(0, 1);
            PUSH_ST(OR_INDEFINITE(fromBits(CONSTANTS[modrm - 0xe8]), t1));
            break;
        }
        case 0xf0:
        {
            double v = hostExpm1(ST(0) * fromBits(0x3fe62e42fefa39efull));
            SET_ST(0, OR_INDEFINITE(v, GUARD(1, 0)));
            break;
        }
        case 0xf1: case 0xf9:
        {
            double r;
            t1 = GUARD(3, 0);
            if (modrm == 0xf1)
            {
                if (precise && ST(0) == 0 && __builtin_fabs(ST(1)) < __builtin_inf() && ST(1) != 0
                    && !t1) status |= S_ZE;
                if (precise && ST(0) < 0) status |= S_IE;
                /* A negative argument's logarithm is the indefinite, not the host's NaN,
                 * and a NaN's is itself: the host's logarithm keeps no NaN's bits. */
                double log = isNaN(ST(0)) ? ST(0)
                    : ST(0) < 0 ? fromBits(INDEFINITE_BITS) : quietNaN(hostLog2(ST(0)));
                r = twoNaN(ST(1) * log, ST(1), log);
            }
            else
            {
                if (precise && ST(0) < -1) status |= S_IE;
                double log = isNaN(ST(0)) ? ST(0) : ST(0) < -1 ? fromBits(INDEFINITE_BITS)
                    : quietNaN(hostLog1p(ST(0))) / fromBits(0x3fe62e42fefa39efull);
                r = twoNaN(ST(1) * log, ST(1), log);
            }
            SET_ST(1, OR_INDEFINITE(r, t1));
            POP_ST();
            break;
        }
        case 0xf3:
        {
            double r = hostAtan2(ST(1), ST(0));
            SET_ST(1, OR_INDEFINITE(r, GUARD(3, 0)));
            POP_ST();
            break;
        }
        case 0xf2: case 0xfb: case 0xfe: case 0xff:
        {
            /* fptan, fsincos, fsin, fcos: out of range leaves ST0 and sets C2. */
            u32 pushes = modrm == 0xf2 || modrm == 0xfb;
            t1 = GUARD(1, pushes);
            status &= ~S_C2;
            double v = ST(0);
            if (__builtin_fabs(v) < 0x1p63 && !isNaN(v) && !t1)
            {
                if (modrm == 0xfb)
                {
                    SET_ST(0, hostSin(v));
                    PUSH_ST(hostCos(v));
                }
                else if (modrm == 0xf2)
                {
                    SET_ST(0, hostTan(v));
                    PUSH_ST(1);
                }
                else SET_ST(0, modrm == 0xfe ? hostSin(v) : hostCos(v));
            }
            else if (isNaN(v) || t1)
            {
                SET_ST(0, fromBits(INDEFINITE_BITS));
                if (pushes) PUSH_ST(fromBits(INDEFINITE_BITS));
            }
            else status |= S_C2;
            break;
        }
        case 0xf4:
        {
            t1 = GUARD(1, 1);
            double original = ST(0), v = original, exponent = 0, significand;
            /* An infinity is its own significand with an exponent of +inf, a NaN both. */
            if (isNaN(v) || __builtin_fabs(v) == __builtin_inf())
            {
                SET_ST(0, OR_INDEFINITE(isNaN(v) ? original : __builtin_inf(), t1));
                PUSH_ST(OR_INDEFINITE(original, t1));
                break;
            }
            if (v == 0)
            {
                /* What an empty register still holds is no operand. */
                if (precise && !t1) status |= S_ZE;
                exponent = -__builtin_inf();
                significand = original;
            }
            else
            {
                if (__builtin_fabs(v) < 0x1p-1022)
                {
                    v *= 0x1p54;
                    exponent = -54;
                }
                u64 word = bitsOf(v);
                exponent += (double)((i32)((word >> 52) & 0x7ff) - 1023);
                significand = fromBits((word & 0x800fffffffffffffull) | 0x3ff0000000000000ull);
            }
            SET_ST(0, OR_INDEFINITE(exponent, t1));
            PUSH_ST(OR_INDEFINITE(significand, t1));
            break;
        }
        case 0xf5: case 0xf8:
        {
            /* fprem1, fprem: the partial remainder, the quotient's low bits in C0 C3 C1,
             * C2 when the reduction is incomplete. */
            t1 = GUARD(3, 0);
            double a = ST(0), c = ST(1);
            if (isNaN(a) || isNaN(c) || __builtin_fabs(a) == __builtin_inf() || c == 0 || t1)
            {
                /* No reduction: C1 and C2 cleared, C0 and C3 as they were. A NaN operand
                 * goes on quiet (of two, the x87's choice), raising IE only if it
                 * signals; anything else is the indefinite and IE. */
                status &= ~(S_C1 | S_C2);
                if (!t1 && (isNaN(a) || isNaN(c)))
                {
                    if (precise && (signalling(a) || signalling(c))) status |= S_IE;
                    SET_ST(0, twoNaN(quietNaN(isNaN(a) ? a : c), a, c));
                    break;
                }
                if (precise) status |= S_IE;
                SET_ST(0, fromBits(INDEFINITE_BITS));
                break;
            }
            u32 bits;
            SET_ST(0, remainderOf(a, c, modrm == 0xf5, &bits));
            status = (status & ~(S_C2 | S_C0 | S_C3 | S_C1)) | bits;
            break;
        }
        case 0xf6:
            top = (top - 1) & 7;
            status &= ~S_C1;
            break;
        case 0xf7:
            top = (top + 1) & 7;
            status &= ~S_C1;
            break;
        case 0xfa:
        {
            t1 = GUARD(1, 0);
            double a = ST(0);
            if (precise && a < 0 && !t1) status |= S_IE;
            SET_ST(0, OR_INDEFINITE(byPrecision(hostNaN(__builtin_sqrt(a), a, a), control), t1));
            break;
        }
        case 0xfc:
        {
            double v = roundBy(ST(0), control);
            SET_ST(0, OR_INDEFINITE(v, GUARD(1, 0)));
            break;
        }
        case 0xfd:
        {
            t1 = GUARD(3, 0);
            double count = __builtin_trunc(ST(1)), v = ST(0);
            count = isNaN(count) ? 0 : clampF(count, -2100, 2100);
            for (u32 pass = 0; pass < 2; pass++)
            {
                double k = clampF(count, -1022, 1023);
                v *= pow2((i32)k);
                count -= k;
            }
            SET_ST(0, OR_INDEFINITE(v, t1));
            break;
        }
        default:
            code = X_LEAVE;
            break;
        }
        break;
    case 2: case 3:
        if (modrm < 0xe0)
        {
            /* fcmovcc: DA b e be u, DB their negations. */
            static const u8 CONDITIONS[4] = { 2, 4, 6, 10 };
            if (!xFlagsExact)
            {
                xNeedsFlags = 1;
                code = X_LEAVE;
                break;
            }
            /* A stack fault leaves the indefinite in ST0, held, whatever the condition. */
            if (GUARD(1 | 1u << i, 0))
            {
                ST(0) = fromBits(INDEFINITE_BITS);
                empty &= ~(1u << top);
                exactMarks &= ~(1u << top);
            }
            else if (holds(CONDITIONS[g & 3] + (e & 1), *eflagsField)) ST(0) = ST(i);
            xnone = 1;
            break;
        }
        if (e == 2)
        {
            if (modrm != 0xe9)
            {
                code = X_LEAVE;
                break;
            }
            t1 = GUARD(3, 0);
            status = compareBits(status, ST(0), ST(1), 0, t1);
            POP_ST();
            POP_ST();
            break;
        }
        if (modrm == 0xe0 || modrm == 0xe1 || modrm == 0xe4) break;
        if (modrm == 0xe2)
        {
            status &= 0x7f00;
            break;
        }
        if (modrm == 0xe3)
        {
            top = 0;
            empty = 0xff;
            status = 0;
            control = 0x37f;
            xnone = 1;
            break;
        }
        if (modrm >= 0xe8 && modrm < 0xf8) goto compareFlags;
        code = X_LEAVE;
        break;
    case 5:
        if (modrm < 0xc8)
        {
            empty |= 1u << PHYS(i);
            xnone = 1;
            break;
        }
        if (modrm < 0xd0) goto fxch;
        if (modrm < 0xe0)
        {
            pops = modrm >= 0xd8;
            goto storeRegister;
        }
        if (modrm < 0xf0)
        {
            t1 = GUARD(1 | 1u << i, 0);
            status = compareBits(status, ST(0), ST(i), 0, t1);
            if (modrm >= 0xe8) POP_ST();
            break;
        }
        code = X_LEAVE;
        break;
    default:
        if (modrm < 0xc8)
        {
            empty |= 1u << PHYS(i);
            POP_ST();
            xnone = 1;
            break;
        }
        if (modrm < 0xd0) goto fxch;
        if (modrm < 0xe0)
        {
            pops = 1;
            goto storeRegister;
        }
        if (modrm == 0xe0)
        {
#ifdef LONG
            *(u16 *)regs = (u16)((status & ~0x3800u) | top << 11);
#else
            regs[0] = (regs[0] & 0xffff0000u) | ((status & ~0x3800u) | top << 11);
#endif
            relaxedReads += !precise;
            break;
        }
        if (modrm >= 0xe8 && modrm < 0xf8)
        {
            pops = 1;
            goto compareFlags;
        }
        code = X_LEAVE;
        break;
    }
    goto done;
fxch:
{
    /* An empty one becomes the indefinite before the exchange, and both are
       held after it, as the processor answers the stack fault. */
    if (GUARD(1 | 1u << i, 0))
    {
        if ((empty >> top) & 1) REG(top) = fromBits(INDEFINITE_BITS);
        if ((empty >> PHYS(i)) & 1) ST(i) = fromBits(INDEFINITE_BITS);
        empty &= ~(1u << top | 1u << PHYS(i));
    }
    double v = REG(top);
    REG(top) = ST(i);
    ST(i) = v;
    status &= ~S_C1;
    /* An exact integer's mark and shadow go with its value. */
    u32 a = top, c = PHYS(i);
    if (((exactMarks >> a | exactMarks >> c) & 1) != 0)
    {
        i64 shadow = exactShadow[a];
        exactShadow[a] = exactShadow[c];
        exactShadow[c] = shadow;
        if (((exactMarks >> a ^ exactMarks >> c) & 1) != 0) exactMarks ^= 1u << a | 1u << c;
    }
    goto done;
}
storeRegister:
{
    /* fst, fstp st(i) */
    t1 = GUARD(1, 0);
    SET_ST(i, OR_INDEFINITE(ST(0), t1));
    xw = 1u << PHYS(i);
    if (!t1 && ((exactMarks >> top) & 1))
    {
        exactShadow[PHYS(i)] = exactShadow[top];
        xm = 1u << PHYS(i);
    }
    if (pops) POP_ST();
    goto done;
}
compareFlags:
{
    /* fucomi, fcomi (DB, DF E8+i and F0+i): ZF PF CF, the others cleared. */
    u32 ordered = modrm >= 0xf0, empties = GUARD(1 | 1u << i, 0);
    double a = ST(0), c = ST(i);
    u32 unordered = empties || isNaN(a) || isNaN(c), f = unordered ? ZF | PF | CF : 0;
    if (unordered || a == c) f |= ZF;
    if (unordered || a < c) f |= CF;
    if (precise)
    {
        if (unordered && (ordered || signalling(a) || signalling(c))) status |= S_IE;
        status &= ~S_C1;
    }
    xFlags = f;
    code = X_FLAGS;
    if (pops) POP_ST();
}
done:
    if ((exactMarks | xm) != 0 && (code == X_DONE || code == X_FLAGS))
        exactMarks = xnone ? 0 : ((exactMarks & ~xw) | xm) & ~xp;
    *x87TopAt = (u8)top;
    *x87EmptyAt = (u8)empty;
    *x87StatusAt = (u16)status;
    *x87ControlAt = (u16)control;
    return code;
}


/*
 * SSE, as ir-simd.js models it and in its order of effects: the XMM registers
 * four words each in the block, a float lane computed in double from its
 * value (a single widened, a signalling NaN quieted as the host's conversion
 * quiets it) and rounded back, a NaN result the first NaN operand's, quieted,
 * or the negative indefinite, and a memory operand read or written whole
 * before anything lands. The MMX forms are the integer ones on the low
 * quadword of an x87 register's slot, as the model reads `f80bits` (`mmx`
 * below); maskmovq and maskmovdqu are left to the JavaScript tier.
 */
typedef union { u8 b[16]; u16 h[8]; u32 w[4]; u64 q[2]; i16 sh[8]; i32 sw[4]; } V128;

#define F32_INDEFINITE 0xffc00000u

static inline u32 isNaN32(u32 bits) { return (bits & 0x7fffffffu) > 0x7f800000u; }
static inline u32 isNaN64(u64 bits) { return (bits & ~SIGN64) > 0x7ff0000000000000ull; }

/* A single as the model's f32At reads it: its double, a NaN quieted. */
static inline double widen(u32 bits)
{
    if (isNaN32(bits))
        return fromBits((u64)(bits >> 31) << 63 | 0x7ff0000000000000ull | (u64)((bits | 0x400000u) & 0x7fffffu) << 29);
    F32 v;
    v.u = bits;
    return (double)v.f;
}

/* A double as the model's putF32 stores it: rounded to a single, a NaN's top payload kept. */
static inline u32 narrow(double d)
{
    u64 bits = bitsOf(d);
    if (isNaN64(bits)) return (u32)(bits >> 63) << 31 | 0x7fc00000u | ((u32)(bits >> 29) & 0x7fffffu);
    F32 v;
    v.f = (float)d;
    return v.u;
}

/* A single lane's result: a NaN the first NaN operand's, quieted, or the indefinite. */
static inline u32 lane32(double r, u32 x, u32 y, u32 inputs)
{
    if (!isNaN(r)) return narrow(r);
    if (isNaN32(x)) return x | 0x400000u;
    if (inputs > 1 && isNaN32(y)) return y | 0x400000u;
    return F32_INDEFINITE;
}

static inline u64 lane64(double r, u64 x, u64 y, u32 inputs)
{
    if (!isNaN(r)) return bitsOf(r);
    if (isNaN64(x)) return x | 0x0008000000000000ull;
    if (inputs > 1 && isNaN64(y)) return y | 0x0008000000000000ull;
    return INDEFINITE_BITS;
}

/* Half to even as the model's roundNearest computes it (-0.5 gives +0). */
static inline double roundNearest(double v)
{
    double low = __builtin_floor(v), diff = v - low;
    if (diff < 0.5) return low;
    if (diff > 0.5) return low + 1;
    return __builtin_floor(low * 0.5) * 2 == low ? low : low + 1;
}

static inline double byMxcsr(double v)
{
    u32 mode = (*mxcsrAt >> 13) & 3;
    if (mode == 1) return __builtin_floor(v);
    if (mode == 2) return __builtin_ceil(v);
    return mode == 3 ? __builtin_trunc(v) : roundNearest(v);
}

/* A float to an i32: NaN and out of range give the integer indefinite. */
static inline u32 floatToInt(double v, u32 isDouble)
{
    double low = isDouble ? -2147483649.0 : -2147483904.0;
    if (isNaN(v) || v >= 2147483648.0 || v <= low) return 0x80000000u;
    return (u32)(i32)v;
}

#ifdef LONG
/* A quadword integer rounded to `bits` significant bits by MXCSR's rounding
 * mode, as ir64.js's roundToBits: exact for a double at 53 and for a single
 * at 24, so the conversion after it rounds nothing a second time. */
static double quadwordRounded(i64 v, u32 bits)
{
    u32 negative = v < 0;
    u64 magnitude = negative ? 0 - (u64)v : (u64)v;
    u32 length = magnitude == 0 ? 0 : 64 - (u32)__builtin_clzll(magnitude);
    if (length > bits)
    {
        u32 drop = length - bits, up;
        u64 kept = magnitude >> drop, rest = magnitude - (kept << drop), half = 1ull << (drop - 1);
        switch ((*mxcsrAt >> 13) & 3)
        {
        case 0: up = rest > half || (rest == half && (kept & 1)); break;
        case 1: up = negative && rest != 0; break;
        case 2: up = !negative && rest != 0; break;
        default: up = 0; break;
        }
        magnitude = (kept + up) << drop;
    }
    double d = (double)magnitude;
    return negative ? -d : d;
}

/* A float to a signed quadword by a rounding mode (MXCSR's encoding, 3 for
 * truncation): NaN and out of range give the integer indefinite. */
static u64 floatToQuadword(double v, u32 mode)
{
    double whole = mode == 1 ? __builtin_floor(v) : mode == 2 ? __builtin_ceil(v)
        : mode == 3 ? __builtin_trunc(v) : roundNearest(v);
    if (isNaN(whole) || whole >= 0x1p63 || whole < -0x1p63) return SIGN64;
    return (u64)(i64)whole;
}
#endif

static inline void getXmm(V128 *v, u32 r)
{
    for (u32 k = 0; k < 4; k++) v->w[k] = xmmRegs[r * 4 + k];
}
static inline void setXmm(u32 r, const V128 *v)
{
    for (u32 k = 0; k < 4; k++) xmmRegs[r * 4 + k] = v->w[k];
}

static inline i32 saturate(i32 v, i32 low, i32 high) { return v < low ? low : v > high ? high : v; }

/* A float lane pair, by the operation of the 0F 5x row: 8 add, 9 mul, c sub, e div. */
static inline double floatOp(u32 op2, double x, double y)
{
    switch (op2 & 0xf)
    {
    case 0x8: return x + y;
    case 0x9: return x * y;
    case 0xc: return x - y;
    default: return x / y;
    }
}

static inline u32 predicate(u32 p, double a, double b)
{
    u32 unordered = isNaN(a) || isNaN(b);
    switch (p & 7)
    {
    case 0: return a == b;
    case 1: return a < b;
    case 2: return a <= b;
    case 3: return unordered;
    case 4: return a != b;
    case 5: return !(a < b);
    case 6: return !(a <= b);
    default: return !unordered;
    }
}

/* The packed integer operations packedInt has, by opcode. */
static const u32 PACKED_INT[8] = { 0, 0, 0, 0x00703fffu, 0, 0, 0xff300000u, 0x7f70ff39u };

/* The packed integer operation of an opcode on 16-byte operands, into d. */
static u32 packedInt(u32 op2, V128 *d, const V128 *s)
{
    V128 r = *d;
    switch (op2)
    {
    case 0xfc: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)(d->b[i] + s->b[i]); break;
    case 0xfd: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)(d->h[i] + s->h[i]); break;
    case 0xfe: for (u32 i = 0; i < 4; i++) r.w[i] = d->w[i] + s->w[i]; break;
    case 0xd4: for (u32 i = 0; i < 2; i++) r.q[i] = d->q[i] + s->q[i]; break;
    case 0xf8: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)(d->b[i] - s->b[i]); break;
    case 0xf9: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)(d->h[i] - s->h[i]); break;
    case 0xfa: for (u32 i = 0; i < 4; i++) r.w[i] = d->w[i] - s->w[i]; break;
    case 0xfb: for (u32 i = 0; i < 2; i++) r.q[i] = d->q[i] - s->q[i]; break;
    case 0xec: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)saturate((i8)d->b[i] + (i8)s->b[i], -128, 127); break;
    case 0xed: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)saturate(d->sh[i] + s->sh[i], -32768, 32767); break;
    case 0xdc: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)saturate(d->b[i] + s->b[i], 0, 255); break;
    case 0xdd: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)saturate(d->h[i] + s->h[i], 0, 65535); break;
    case 0xe8: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)saturate((i8)d->b[i] - (i8)s->b[i], -128, 127); break;
    case 0xe9: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)saturate(d->sh[i] - s->sh[i], -32768, 32767); break;
    case 0xd8: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)saturate((i32)d->b[i] - s->b[i], 0, 255); break;
    case 0xd9: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)saturate((i32)d->h[i] - s->h[i], 0, 65535); break;
    case 0x74: for (u32 i = 0; i < 16; i++) r.b[i] = d->b[i] == s->b[i] ? 0xff : 0; break;
    case 0x75: for (u32 i = 0; i < 8; i++) r.h[i] = d->h[i] == s->h[i] ? 0xffff : 0; break;
    case 0x76: for (u32 i = 0; i < 4; i++) r.w[i] = d->w[i] == s->w[i] ? 0xffffffffu : 0; break;
    case 0x64: for (u32 i = 0; i < 16; i++) r.b[i] = (i8)d->b[i] > (i8)s->b[i] ? 0xff : 0; break;
    case 0x65: for (u32 i = 0; i < 8; i++) r.h[i] = d->sh[i] > s->sh[i] ? 0xffff : 0; break;
    case 0x66: for (u32 i = 0; i < 4; i++) r.w[i] = d->sw[i] > s->sw[i] ? 0xffffffffu : 0; break;
    case 0xd5: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)((u32)d->h[i] * s->h[i]); break;
    case 0xda: for (u32 i = 0; i < 16; i++) r.b[i] = d->b[i] < s->b[i] ? d->b[i] : s->b[i]; break;
    case 0xde: for (u32 i = 0; i < 16; i++) r.b[i] = d->b[i] > s->b[i] ? d->b[i] : s->b[i]; break;
    case 0xea: for (u32 i = 0; i < 8; i++) r.sh[i] = d->sh[i] < s->sh[i] ? d->sh[i] : s->sh[i]; break;
    case 0xee: for (u32 i = 0; i < 8; i++) r.sh[i] = d->sh[i] > s->sh[i] ? d->sh[i] : s->sh[i]; break;
    case 0xe0: for (u32 i = 0; i < 16; i++) r.b[i] = (u8)((d->b[i] + s->b[i] + 1) >> 1); break;
    case 0xe3: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)((d->h[i] + s->h[i] + 1) >> 1); break;
    case 0xf5:
        for (u32 i = 0; i < 4; i++)
            r.w[i] = (u32)(d->sh[2 * i] * s->sh[2 * i]) + (u32)(d->sh[2 * i + 1] * s->sh[2 * i + 1]);
        break;
    case 0xe5: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)((d->sh[i] * s->sh[i]) >> 16); break;
    case 0xe4: for (u32 i = 0; i < 8; i++) r.h[i] = (u16)(((u32)d->h[i] * s->h[i]) >> 16); break;
    case 0xf4: for (u32 i = 0; i < 2; i++) r.q[i] = (u64)d->w[i * 2] * s->w[i * 2]; break;
    case 0xf6:
        for (u32 half = 0; half < 16; half += 8)
        {
            u32 sum = 0;
            for (u32 i = 0; i < 8; i++)
            {
                i32 diff = (i32)d->b[half + i] - s->b[half + i];
                sum += (u32)(diff < 0 ? -diff : diff);
            }
            r.q[half >> 3] = sum;
        }
        break;
    case 0xdb: for (u32 i = 0; i < 4; i++) r.w[i] = d->w[i] & s->w[i]; break;
    case 0xdf: for (u32 i = 0; i < 4; i++) r.w[i] = ~d->w[i] & s->w[i]; break;
    case 0xeb: for (u32 i = 0; i < 4; i++) r.w[i] = d->w[i] | s->w[i]; break;
    case 0xef: for (u32 i = 0; i < 4; i++) r.w[i] = d->w[i] ^ s->w[i]; break;
    case 0x60: case 0x61: case 0x62: case 0x6c: case 0x68: case 0x69: case 0x6a: case 0x6d:
    {
        /* The unpacks: the low (or high) halves interleaved at the element width. */
        u32 element = (op2 & 3) == 0 ? 1 : (op2 & 3) == 1 ? 2 : (op2 & 3) == 2 ? 4 : 8;
        if (op2 == 0x6c || op2 == 0x6d) element = 8;
        u32 from = op2 == 0x68 || op2 == 0x69 || op2 == 0x6a || op2 == 0x6d ? 8 : 0, at = 0;
        for (u32 i = 0; i < 8 / element; i++)
        {
            for (u32 k = 0; k < element; k++) r.b[at++] = d->b[from + i * element + k];
            for (u32 k = 0; k < element; k++) r.b[at++] = s->b[from + i * element + k];
        }
        break;
    }
    case 0x63: case 0x67: case 0x6b:
    {
        /* The narrowing packs with saturation, the first operand's lanes first. */
        const V128 *both[2] = { d, s };
        for (u32 k = 0; k < 2; k++)
        {
            if (op2 == 0x6b)
                for (u32 i = 0; i < 4; i++) r.h[k * 4 + i] = (u16)saturate(both[k]->sw[i], -32768, 32767);
            else
                for (u32 i = 0; i < 8; i++)
                    r.b[k * 8 + i] = (u8)(op2 == 0x67 ? saturate(both[k]->sh[i], 0, 255) : saturate(both[k]->sh[i], -128, 127));
        }
        break;
    }
    default:
        return 0;
    }
    *d = r;
    return 1;
}

/* psrl/psra/psll of every element by `amount` (already capped at 64 as the model caps it):
 * kind 2 logical right, 4 arithmetic right, 6 left; element 2, 4 or 8 bytes. */
static void packedShift(V128 *d, u32 kind, u32 element, u32 amount)
{
    u32 limit = element * 8;
    if (element == 8)
    {
        for (u32 i = 0; i < 2; i++)
        {
            if (kind == 6) d->q[i] = amount >= 64 ? 0 : d->q[i] << amount;
            else d->q[i] = amount >= limit ? 0 : d->q[i] >> amount;
        }
        return;
    }
    for (u32 i = 0; i < 16 / element; i++)
    {
        if (element == 4)
        {
            if (kind == 6) d->w[i] = amount >= limit ? 0 : d->w[i] << amount;
            else if (kind == 4) d->sw[i] = d->sw[i] >> (amount < limit - 1 ? amount : limit - 1);
            else d->w[i] = amount >= limit ? 0 : d->w[i] >> amount;
        }
        else
        {
            if (kind == 6) d->h[i] = amount >= limit ? 0 : (u16)(d->h[i] << amount);
            else if (kind == 4) d->sh[i] = (i16)(d->sh[i] >> (amount < limit - 1 ? amount : limit - 1));
            else d->h[i] = amount >= limit ? 0 : (u16)(d->h[i] >> amount);
        }
    }
}

#ifdef LONG
/* A 16-byte memory operand of a legacy SSE instruction must be aligned but for
 * the unaligned moves' (`unaligned`), as ir64.js faults it (#GP). */
#define X_ALIGNED(width) do { if ((width) == 16 && !unaligned && (ea & 15) != 0) { code = X_FAULT; goto done; } } while (0)
#else
#define X_ALIGNED(width) do { } while (0)
#endif
/* The memory operand loaded as the model's readVector reads it: `width` bytes, the rest zero. */
#define LOAD_M(v, width) do { \
        X_ALIGNED(width); \
        X_READ(ea, (width)); \
        (v).q[0] = 0; (v).q[1] = 0; \
        if ((width) == 16) { (v).q[0] = *(u64 *)(ram + ea); (v).q[1] = *(u64 *)(ram + ea + 8); } \
        else if ((width) == 8) (v).q[0] = *(u64 *)(ram + ea); \
        else if ((width) == 4) (v).w[0] = *(u32 *)(ram + ea); \
        else (v).h[0] = *(u16 *)(ram + ea); \
    } while (0)
/* The W operand: the xmm register or `width` bytes of memory. */
#define LOAD_W(v, width) do { if (mem) LOAD_M(v, width); else getXmm(&(v), rm); } while (0)
#define STORE_M(v, width) do { \
        X_ALIGNED(width); \
        X_WRITE(ea, (width)); \
        if ((width) == 16) { *(u64 *)(ram + ea) = (v).q[0]; *(u64 *)(ram + ea + 8) = (v).q[1]; } \
        else if ((width) == 8) *(u64 *)(ram + ea) = (v).q[0]; \
        else *(u32 *)(ram + ea) = (v).w[0]; \
    } while (0)

/*
 * MMX, as ir-simd.js models it: an `mm` register is the low quadword of the
 * physical x87 register's slot (the model's `f80bits`), a write takes the
 * register's exact-integer mark off, and an instruction with an `mm` operand
 * leaves the stack in the MMX state -- top zero, every register held -- as
 * the model's `mmxState` does after it. The interpreter ran each of them in
 * JavaScript, one instruction a crossing: a software mixer's loop interpreted
 * while its translation was formed again cost most of a frame.
 */
static inline u64 getMm(u32 r) { return *(u64 *)(x87Regs + (r & 7) * 16); }
static inline void setMm(u32 r, u64 v)
{
    *(u64 *)(x87Regs + (r & 7) * 16) = v;
    exactMarks &= ~(1u << (r & 7));
}

/* The opcodes after 0F whose unprefixed form is an MMX one modelled here. */
static inline u32 mmxForm(u32 op2)
{
    if (op2 == 0x6c || op2 == 0x6d) return 0;
    if ((PACKED_INT[op2 >> 5] >> (op2 & 31)) & 1) return 1;
    switch (op2)
    {
    case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72: case 0x73: case 0x7e: case 0x7f:
    case 0xc4: case 0xc5: case 0xd1: case 0xd2: case 0xd3: case 0xd7: case 0xe1: case 0xe2:
    case 0xe7: case 0xf1: case 0xf2: case 0xf3:
        return 1;
    default:
        return 0;
    }
}

/*
 * One MMX instruction past its addressing bytes (*len at the immediate, if
 * any): the operation the 66 form has, on the low quadwords, where it is the
 * same; the high unpacks from the high doublewords moved down, the packs from
 * both operands in one register's two quadwords.
 */
static u32 mmx(u32 op2, u32 reg, u32 rm, u32 mem, u32 ea, u32 imm, u32 *len)
{
    u32 code = X_DONE;
    V128 a, b;
    a.q[1] = 0;
    b.q[1] = 0;
    /* The source: the mm register, or `width` bytes of memory zero-extended. */
#define MM_SOURCE(v, width) do { \
        if (mem) { X_READ(ea, (width)); \
            (v).q[0] = (width) == 8 ? *(u64 *)(ram + ea) : (width) == 4 ? *(u32 *)(ram + ea) \
                : *(u16 *)(ram + ea); } \
        else (v).q[0] = getMm(rm); \
        (v).q[1] = 0; \
    } while (0)
    switch (op2)
    {
    case 0x6e:
        /* movd mm, r/m32 */
        if (mem) { X_READ(ea, 4); a.q[0] = *(u32 *)(ram + ea); }
        else a.q[0] = (u32)regs[rm];
        setMm(reg, a.q[0]);
        break;
    case 0x7e:
        /* movd r/m32, mm */
        if (mem) { X_WRITE(ea, 4); *(u32 *)(ram + ea) = (u32)getMm(reg); }
        else regs[rm] = (u32)getMm(reg);
        break;
    case 0x6f:
        /* movq mm, mm/m64 */
        MM_SOURCE(b, 8);
        setMm(reg, b.q[0]);
        break;
    case 0x7f: case 0xe7:
        /* movq mm/m64, mm; movntq m64, mm */
        if (op2 == 0xe7 && !mem) { code = X_LEAVE; break; }
        if (mem) { X_WRITE(ea, 8); *(u64 *)(ram + ea) = getMm(reg); }
        else setMm(rm, getMm(reg));
        break;
    case 0x70:
        /* pshufw mm, mm/m64, imm8 */
        MM_SOURCE(b, 8);
        *len += 1;
        for (u32 i = 0; i < 4; i++) a.h[i] = b.h[(imm >> (i * 2)) & 3];
        setMm(reg, a.q[0]);
        break;
    case 0x71: case 0x72: case 0x73:
    {
        /* psrl /2, psra /4, psll /6 by an immediate; 73 has no psra */
        if (mem || !(reg == 2 || reg == 6 || (reg == 4 && op2 != 0x73))) { code = X_LEAVE; break; }
        a.q[0] = getMm(rm);
        *len += 1;
        packedShift(&a, reg, op2 == 0x71 ? 2 : op2 == 0x72 ? 4 : 8, imm);
        setMm(rm, a.q[0]);
        break;
    }
    case 0xd1: case 0xd2: case 0xd3: case 0xe1: case 0xe2: case 0xf1: case 0xf2: case 0xf3:
    {
        /* The shifts by mm/m64's quadword. */
        u32 element = (op2 & 3) == 1 ? 2 : (op2 & 3) == 2 ? 4 : 8;
        u32 kind = op2 >= 0xf0 ? 6 : op2 >= 0xe0 ? 4 : 2;
        MM_SOURCE(b, 8);
        a.q[0] = getMm(reg);
        packedShift(&a, kind, element, b.q[0] > 0xffffffffull ? 64 : (u32)b.q[0]);
        setMm(reg, a.q[0]);
        break;
    }
    case 0xc4:
    {
        /* pinsrw mm, r32/m16, imm8 */
        u32 v;
        if (mem) { X_READ(ea, 2); v = *(u16 *)(ram + ea); }
        else v = regs[rm];
        *len += 1;
        a.q[0] = getMm(reg);
        a.h[imm & 3] = (u16)v;
        setMm(reg, a.q[0]);
        break;
    }
    case 0xc5:
        /* pextrw r32, mm, imm8 */
        if (mem) { code = X_LEAVE; break; }
        *len += 1;
        b.q[0] = getMm(rm);
        regs[reg] = b.h[imm & 3];
        break;
    case 0xd7:
    {
        /* pmovmskb r32, mm */
        if (mem) { code = X_LEAVE; break; }
        b.q[0] = getMm(rm);
        u32 mask = 0;
        for (u32 i = 0; i < 8; i++) mask |= (u32)(b.b[i] >> 7) << i;
        regs[reg] = mask;
        break;
    }
    default:
        a.q[0] = getMm(reg);
        MM_SOURCE(b, 8);
        if (op2 == 0x68 || op2 == 0x69 || op2 == 0x6a)
        {
            /* The high doublewords, moved down to be unpacked as the low ones are. */
            a.q[0] >>= 32;
            b.q[0] >>= 32;
            op2 -= 8;
        }
        else if (op2 == 0x63 || op2 == 0x67 || op2 == 0x6b)
        {
            /* Both operands in one register, packed against itself: the low
             * quadword of the result is the first's lanes and then the second's. */
            a.q[1] = b.q[0];
            b = a;
        }
        packedInt(op2, &a, &b);
        setMm(reg, a.q[0]);
        break;
    }
#undef MM_SOURCE
done:
    if (code == X_DONE)
    {
        *x87TopAt = 0;
        *x87EmptyAt = 0;
    }
    return code;
}

/*
 * One SSE instruction, at p (0F and the byte after it past the prefixes), taken
 * as x87 is. Nothing runs before a form is known to be modelled, so X_LEAVE
 * leaves the state as it was.
 */
__attribute__((noinline))
static u32 sse(const u8 *p)
{
    SegmentBase seg;
    u32 len, key, lock;
    prefixed(p, &len, &seg, &key, &lock);
    if (lock) return X_LEAVE;
    if (key == 0 && p[len] == 0x77)
    {
        /* emms: every register empty, the top at zero */
        *x87EmptyAt = 0xff;
        *x87TopAt = 0;
        xWrite = NONE;
        xLen = len + 1;
        return X_DONE;
    }
    u32 op2 = p[len++], modrm = p[len], ea = 0, mem = modrm < 0xc0, reg = (modrm >> 3) & 7;
    u32 rm = modrm & 7;
#ifdef LONG
    /* REX.R and REX.B reach XMM8-15 and the further general registers; an `mm`
     * operand ignores them, which getMm's mask does. */
    reg |= (xRex & 4) << 1;
    if (!mem) rm |= (xRex & 1) << 3;
    /* The forms with an immediate past the addressing bytes, which a
     * RIP-relative address is counted from the end of. */
    u32 extra = op2 == 0x70 || op2 == 0xc2 || op2 == 0xc4 || op2 == 0xc5 || op2 == 0xc6;
    u32 unaligned = ((op2 == 0x10 || op2 == 0x11) && key <= 1) || ((op2 == 0x6f || op2 == 0x7f) && key == 2)
        || (op2 == 0xf0 && key == 3);
#endif
    if (mem) ea = MEMORY_OPERAND(p, &len, seg, extra);
    else len += 1;
    xWrite = NONE;
    u32 code = X_DONE;
    V128 a, b;
    /* The immediate, for the forms that have one, after the addressing bytes. */
    u32 imm = p[len];
#ifdef LONG
    if (xRex & 8)
    {
        /* REX.W: a quadword where 32-bit code has a dword general operand, as
         * ir64.js moves and converts it. MMX's quadword moves are the
         * JavaScript tier's. */
        if ((op2 == 0x6e || op2 == 0x7e) && key == 0)
        {
            code = X_LEAVE;
            goto done;
        }
        if (op2 == 0x6e && key == 1)
        {
            /* movq xmm, r/m64: the high quadword zeroed */
            a.q[1] = 0;
            if (mem) { X_READ(ea, 8); a.q[0] = *(u64 *)(ram + ea); }
            else a.q[0] = regs[rm];
            setXmm(reg, &a);
            goto done;
        }
        if (op2 == 0x7e && key == 1)
        {
            /* movq r/m64, xmm */
            getXmm(&a, reg);
            if (mem) { X_WRITE(ea, 8); *(u64 *)(ram + ea) = a.q[0]; }
            else regs[rm] = a.q[0];
            goto done;
        }
        if (op2 == 0x2a && key >= 2)
        {
            /* cvtsi2ss, cvtsi2sd r/m64: rounded once, by MXCSR */
            i64 v;
            if (mem) { X_READ(ea, 8); v = *(i64 *)(ram + ea); }
            else v = (i64)regs[rm];
            getXmm(&a, reg);
            if (key == 2) a.w[0] = narrow(quadwordRounded(v, 24));
            else a.q[0] = bitsOf(quadwordRounded(v, 53));
            setXmm(reg, &a);
            goto done;
        }
        if ((op2 == 0x2c || op2 == 0x2d) && key >= 2)
        {
            /* cvttss2si, cvtss2si, cvttsd2si, cvtsd2si r64 */
            double v;
            if (key == 2) { LOAD_W(b, 4); v = widen(b.w[0]); }
            else { LOAD_W(b, 8); v = fromBits(b.q[0]); }
            regs[reg] = floatToQuadword(v, op2 == 0x2c ? 3 : (*mxcsrAt >> 13) & 3);
            goto done;
        }
    }
#endif
    if (key == 0 && mmxForm(op2))
    {
        code = mmx(op2, reg, rm, mem, ea, imm, &len);
        goto done;
    }
    switch (op2)
    {
    case 0x10: case 0x11:
        if (key <= 1)
        {
            /* movups, movupd */
            if (op2 == 0x10) { LOAD_W(b, 16); setXmm(reg, &b); }
            else { getXmm(&b, reg); if (mem) STORE_M(b, 16); else setXmm(rm, &b); }
            break;
        }
        {
            /* movss, movsd */
            u32 lane = key == 2 ? 4 : 8;
            if (op2 == 0x10)
            {
                if (mem) { LOAD_M(b, lane); setXmm(reg, &b); break; }
                getXmm(&a, reg);
                getXmm(&b, rm);
            }
            else
            {
                if (mem) { getXmm(&b, reg); STORE_M(b, lane); break; }
                getXmm(&a, rm);
                getXmm(&b, reg);
            }
            a.w[0] = b.w[0];
            if (lane == 8) a.w[1] = b.w[1];
            setXmm(op2 == 0x10 ? reg : rm, &a);
        }
        break;
    case 0x12: case 0x16:
        getXmm(&a, reg);
        if (key == 2)
        {
            /* movsldup, movshdup */
            LOAD_W(b, 16);
            u32 lane = op2 == 0x16;
            a.w[0] = b.w[lane]; a.w[1] = b.w[lane]; a.w[2] = b.w[2 + lane]; a.w[3] = b.w[2 + lane];
        }
        else if (key == 3)
        {
            /* movddup */
            if (op2 == 0x16) { code = X_LEAVE; break; }
            LOAD_W(b, 8);
            a.q[0] = b.q[0];
            a.q[1] = b.q[0];
        }
        else if (mem)
        {
            /* movlps, movlpd, movhps, movhpd from memory */
            LOAD_M(b, 8);
            a.q[op2 == 0x16] = b.q[0];
        }
        else
        {
            /* movhlps, movlhps; movlpd and movhpd take memory alone */
            if (key == 1) { code = X_LEAVE; break; }
            getXmm(&b, rm);
            if (op2 == 0x16) a.q[1] = b.q[0];
            else a.q[0] = b.q[1];
        }
        if (code == X_DONE) setXmm(reg, &a);
        break;
    case 0x13: case 0x17:
        /* movlps, movlpd, movhps, movhpd to memory */
        if (!mem || key > 1) { code = X_LEAVE; break; }
        getXmm(&a, reg);
        b.q[0] = a.q[op2 == 0x17];
        STORE_M(b, 8);
        break;
    case 0x14: case 0x15:
        /* unpcklps, unpckhps, unpcklpd, unpckhpd */
        if (key > 1) { code = X_LEAVE; break; }
        getXmm(&a, reg);
        LOAD_W(b, 16);
        {
            u32 high = op2 == 0x15;
            V128 r;
            if (key == 1) { r.q[0] = a.q[high]; r.q[1] = b.q[high]; }
            else
            {
                r.w[0] = a.w[high * 2]; r.w[1] = b.w[high * 2];
                r.w[2] = a.w[high * 2 + 1]; r.w[3] = b.w[high * 2 + 1];
            }
            setXmm(reg, &r);
        }
        break;
    case 0x28: case 0x29:
        /* movaps, movapd */
        if (key > 1) { code = X_LEAVE; break; }
        if (op2 == 0x28) { LOAD_W(b, 16); setXmm(reg, &b); }
        else { getXmm(&b, reg); if (mem) STORE_M(b, 16); else setXmm(rm, &b); }
        break;
    case 0x2a:
    {
        /* cvtsi2ss, cvtsi2sd */
        if (key < 2) { code = X_LEAVE; break; }
        i32 v;
        if (mem) { X_READ(ea, 4); v = *(i32 *)(ram + ea); }
        else v = (i32)regs[rm];
        getXmm(&a, reg);
        if (key == 2) a.w[0] = narrow((double)v);
        else a.q[0] = bitsOf((double)v);
        setXmm(reg, &a);
        break;
    }
    case 0x2b:
        /* movntps, movntpd */
        if (key > 1 || !mem) { code = X_LEAVE; break; }
        getXmm(&b, reg);
        STORE_M(b, 16);
        break;
    case 0x2c: case 0x2d:
    {
        /* cvttss2si, cvtss2si, cvttsd2si, cvtsd2si */
        if (key < 2) { code = X_LEAVE; break; }
        double v;
        if (key == 2) { LOAD_W(b, 4); v = widen(b.w[0]); }
        else { LOAD_W(b, 8); v = fromBits(b.q[0]); }
        if (op2 == 0x2d) v = byMxcsr(v);
        regs[reg] = floatToInt(v, key == 3);
        break;
    }
    case 0x2e: case 0x2f:
    {
        /* ucomiss, comiss, ucomisd, comisd: ZF PF CF, the others cleared */
        if (key > 1) { code = X_LEAVE; break; }
        double x, y;
        getXmm(&a, reg);
        if (key == 0) { LOAD_W(b, 4); x = widen(a.w[0]); y = widen(b.w[0]); }
        else { LOAD_W(b, 8); x = fromBits(a.q[0]); y = fromBits(b.q[0]); }
        u32 unordered = isNaN(x) || isNaN(y);
        xFlags = (unordered ? ZF | PF | CF : 0) | (!unordered && x == y ? ZF : 0)
            | (!unordered && x < y ? CF : 0);
        code = X_FLAGS;
        break;
    }
    case 0x50:
        /* movmskps, movmskpd */
        if (key > 1 || mem) { code = X_LEAVE; break; }
        getXmm(&b, rm);
        regs[reg] = key == 0 ? (b.w[0] >> 31) | (b.w[1] >> 31) << 1 | (b.w[2] >> 31) << 2 | (b.w[3] >> 31) << 3
            : (u32)(b.q[0] >> 63) | (u32)(b.q[1] >> 63) << 1;
        break;
    case 0x51: case 0x52: case 0x53:
    {
        /* sqrt, rsqrt, rcp: ps pd ss sd (rsqrt and rcp single alone) */
        if (op2 != 0x51 && (key == 1 || key == 3)) { code = X_LEAVE; break; }
        u32 isDouble = key == 1 || key == 3, scalar = key >= 2;
        getXmm(&a, reg);
        LOAD_W(b, scalar ? (isDouble ? 8 : 4) : 16);
        for (u32 i = 0; i < (scalar ? 1 : isDouble ? 2 : 4); i++)
        {
            if (isDouble)
            {
                double x = fromBits(b.q[i]);
                a.q[i] = lane64(__builtin_sqrt(x), b.q[i], 0, 1);
            }
            else
            {
                double x = widen(b.w[i]);
                /* rsqrt's root rounded to a single first, as the translation does it */
                double r = op2 == 0x51 ? __builtin_sqrt(x)
                    : op2 == 0x52 ? 1 / (double)(float)__builtin_sqrt(x) : 1 / x;
                a.w[i] = lane32(r, b.w[i], 0, 1);
            }
        }
        setXmm(reg, &a);
        break;
    }
    case 0x54: case 0x55: case 0x56: case 0x57:
        /* and, andn, or, xor: ps pd */
        if (key > 1) { code = X_LEAVE; break; }
        getXmm(&a, reg);
        LOAD_W(b, 16);
        for (u32 i = 0; i < 4; i++)
            a.w[i] = op2 == 0x54 ? a.w[i] & b.w[i] : op2 == 0x55 ? ~a.w[i] & b.w[i]
                : op2 == 0x56 ? a.w[i] | b.w[i] : a.w[i] ^ b.w[i];
        setXmm(reg, &a);
        break;
    case 0x58: case 0x59: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
    {
        /* add mul sub min div max: ps pd ss sd */
        u32 isDouble = key == 1 || key == 3, scalar = key >= 2, minmax = op2 == 0x5d || op2 == 0x5f;
        getXmm(&a, reg);
        LOAD_W(b, scalar ? (isDouble ? 8 : 4) : 16);
        for (u32 i = 0; i < (scalar ? 1 : isDouble ? 2 : 4); i++)
        {
            if (isDouble)
            {
                double x = fromBits(a.q[i]), y = fromBits(b.q[i]);
                if (minmax) a.q[i] = (op2 == 0x5d ? x < y : x > y) ? a.q[i] : b.q[i];
                else a.q[i] = lane64(floatOp(op2, x, y), a.q[i], b.q[i], 2);
            }
            else if (minmax)
            {
                /* The operand chosen, bit for bit: a signalling NaN goes through as it is. */
                double x = widen(a.w[i]), y = widen(b.w[i]);
                a.w[i] = (op2 == 0x5d ? x < y : x > y) ? a.w[i] : b.w[i];
            }
            else a.w[i] = lane32(floatOp(op2, widen(a.w[i]), widen(b.w[i])), a.w[i], b.w[i], 2);
        }
        setXmm(reg, &a);
        break;
    }
    case 0x5a:
        getXmm(&a, reg);
        if (key == 0)
        {
            /* cvtps2pd */
            LOAD_W(b, 8);
            a.q[0] = bitsOf(widen(b.w[0]));
            a.q[1] = bitsOf(widen(b.w[1]));
        }
        else if (key == 1)
        {
            /* cvtpd2ps */
            LOAD_W(b, 16);
            a.w[0] = narrow(fromBits(b.q[0]));
            a.w[1] = narrow(fromBits(b.q[1]));
            a.q[1] = 0;
        }
        else if (key == 2)
        {
            /* cvtss2sd */
            LOAD_W(b, 4);
            a.q[0] = bitsOf(widen(b.w[0]));
        }
        else
        {
            /* cvtsd2ss */
            LOAD_W(b, 8);
            a.w[0] = narrow(fromBits(b.q[0]));
        }
        setXmm(reg, &a);
        break;
    case 0x5b:
        /* cvtdq2ps, cvtps2dq, cvttps2dq */
        if (key == 3) { code = X_LEAVE; break; }
        LOAD_W(b, 16);
        for (u32 i = 0; i < 4; i++)
        {
            if (key == 0) a.w[i] = narrow((double)b.sw[i]);
            else a.w[i] = floatToInt(key == 1 ? byMxcsr(widen(b.w[i])) : widen(b.w[i]), 0);
        }
        setXmm(reg, &a);
        break;
    case 0x6e:
        /* movd xmm, r/m32 */
        if (key != 1) { code = X_LEAVE; break; }
        a.q[0] = 0;
        a.q[1] = 0;
        if (mem) { X_READ(ea, 4); a.w[0] = *(u32 *)(ram + ea); }
        else a.w[0] = regs[rm];
        setXmm(reg, &a);
        break;
    case 0x7e:
        if (key == 1)
        {
            /* movd r/m32, xmm */
            getXmm(&a, reg);
            if (mem) STORE_M(a, 4);
            else regs[rm] = a.w[0];
            break;
        }
        if (key != 2) { code = X_LEAVE; break; }
        /* movq xmm, xmm/m64: the high half zeroed */
        LOAD_W(b, 8);
        b.q[1] = 0;
        setXmm(reg, &b);
        break;
    case 0x6f: case 0x7f:
        /* movdqa, movdqu */
        if (key == 0 || key == 3) { code = X_LEAVE; break; }
        if (op2 == 0x6f) { LOAD_W(b, 16); setXmm(reg, &b); }
        else { getXmm(&b, reg); if (mem) STORE_M(b, 16); else setXmm(rm, &b); }
        break;
    case 0x70:
    {
        /* pshufd, pshufhw, pshuflw */
        if (key == 0) { code = X_LEAVE; break; }
        LOAD_W(b, 16);
        len += 1;
        a = b;
        if (key == 1)
            for (u32 i = 0; i < 4; i++) a.w[i] = b.w[(imm >> (i * 2)) & 3];
        else
        {
            u32 base = key == 2 ? 4 : 0;
            for (u32 i = 0; i < 4; i++) a.h[base + i] = b.h[base + ((imm >> (i * 2)) & 3)];
        }
        setXmm(reg, &a);
        break;
    }
    case 0x71: case 0x72: case 0x73:
    {
        /* The shifts by an immediate: psrl /2, psra /4, psll /6; 73 /3 psrldq, /7 pslldq. */
        if (key != 1 || mem) { code = X_LEAVE; break; }
        u32 element = op2 == 0x71 ? 2 : op2 == 0x72 ? 4 : 8;
        u32 known = op2 == 0x73 ? (reg == 2 || reg == 3 || reg == 6 || reg == 7) : (reg == 2 || reg == 4 || reg == 6);
        if (!known) { code = X_LEAVE; break; }
        getXmm(&a, rm);
        len += 1;
        if (op2 == 0x73 && (reg == 3 || reg == 7))
        {
            u32 count = imm < 16 ? imm : 16;
            for (u32 i = 0; i < 16; i++)
            {
                i32 from = reg == 7 ? (i32)i - (i32)count : (i32)(i + count);
                b.b[i] = from >= 0 && from < 16 ? a.b[from] : 0;
            }
            setXmm(rm, &b);
            break;
        }
        packedShift(&a, reg, element, imm);
        setXmm(rm, &a);
        break;
    }
    case 0xd1: case 0xd2: case 0xd3: case 0xe1: case 0xe2: case 0xf1: case 0xf2: case 0xf3:
    {
        /* The shifts by a register or memory count: its low quadword, 8 bytes of memory. */
        if (key != 1) { code = X_LEAVE; break; }
        u32 element = (op2 & 3) == 1 ? 2 : (op2 & 3) == 2 ? 4 : 8;
        u32 kind = op2 >= 0xf0 ? 6 : op2 >= 0xe0 ? 4 : 2;
#ifdef LONG
        /* The count's operand is sixteen bytes, aligned as any, of which the low eight count. */
        if (mem && (ea & 15) != 0) { code = X_FAULT; break; }
#endif
        LOAD_W(b, 8);
        getXmm(&a, reg);
        packedShift(&a, kind, element, b.q[0] > 0xffffffffull ? 64 : (u32)b.q[0]);
        setXmm(reg, &a);
        break;
    }
    case 0x7c: case 0x7d: case 0xd0:
    {
        /* haddpd, haddps, hsubpd, hsubps; addsubpd, addsubps */
        if (key != 1 && key != 3) { code = X_LEAVE; break; }
        u32 isDouble = key == 1, lanes = isDouble ? 2 : 4, half = lanes / 2;
        getXmm(&a, reg);
        LOAD_W(b, 16);
        V128 r;
        for (u32 i = 0; i < lanes; i++)
        {
            u64 x, y;
            u32 subtract;
            if (op2 == 0xd0)
            {
                x = isDouble ? a.q[i] : a.w[i];
                y = isDouble ? b.q[i] : b.w[i];
                subtract = (i & 1) == 0;
            }
            else
            {
                const V128 *pair = i < half ? &a : &b;
                u32 base = (i % half) * 2;
                x = isDouble ? pair->q[base] : pair->w[base];
                y = isDouble ? pair->q[base + 1] : pair->w[base + 1];
                subtract = op2 == 0x7d;
            }
            if (isDouble)
            {
                double dx = fromBits(x), dy = fromBits(y);
                r.q[i] = lane64(subtract ? dx - dy : dx + dy, x, y, 2);
            }
            else
            {
                double dx = widen((u32)x), dy = widen((u32)y);
                r.w[i] = lane32(subtract ? dx - dy : dx + dy, (u32)x, (u32)y, 2);
            }
        }
        setXmm(reg, &r);
        break;
    }
    case 0xae:
        if (key > 1) { code = X_LEAVE; break; }
        if (!mem)
        {
            /* lfence, mfence, sfence */
            if (reg < 5) code = X_LEAVE;
            break;
        }
        if (reg == 2) { X_READ(ea, 4); *mxcsrAt = *(u32 *)(ram + ea); }
        else if (reg == 3) { X_WRITE(ea, 4); *(u32 *)(ram + ea) = *mxcsrAt; }
        else code = X_LEAVE;
        break;
    case 0xc2:
    {
        /* cmpps, cmppd, cmpss, cmpsd */
        u32 isDouble = key == 1 || key == 3, scalar = key >= 2;
        getXmm(&a, reg);
        LOAD_W(b, scalar ? (isDouble ? 8 : 4) : 16);
        imm = p[len];
        len += 1;
        for (u32 i = 0; i < (scalar ? 1 : isDouble ? 2 : 4); i++)
        {
            if (isDouble) a.q[i] = predicate(imm, fromBits(a.q[i]), fromBits(b.q[i])) ? ~0ull : 0;
            else a.w[i] = predicate(imm, widen(a.w[i]), widen(b.w[i])) ? ~0u : 0;
        }
        setXmm(reg, &a);
        break;
    }
    case 0xc4:
        /* pinsrw xmm, r32/m16, imm8 */
        if (key != 1) { code = X_LEAVE; break; }
        {
            u32 v;
            if (mem) { X_READ(ea, 2); v = *(u16 *)(ram + ea); }
            else v = regs[rm];
            imm = p[len];
            len += 1;
            getXmm(&a, reg);
            a.h[imm & 7] = (u16)v;
            setXmm(reg, &a);
        }
        break;
    case 0xc5:
        /* pextrw r32, xmm, imm8 */
        if (key != 1 || mem) { code = X_LEAVE; break; }
        getXmm(&b, rm);
        len += 1;
        regs[reg] = b.h[imm & 7];
        break;
    case 0xc6:
    {
        /* shufps, shufpd */
        if (key > 1) { code = X_LEAVE; break; }
        getXmm(&a, reg);
        LOAD_W(b, 16);
        imm = p[len];
        len += 1;
        V128 r;
        if (key == 0)
        {
            r.w[0] = a.w[imm & 3]; r.w[1] = a.w[(imm >> 2) & 3];
            r.w[2] = b.w[(imm >> 4) & 3]; r.w[3] = b.w[(imm >> 6) & 3];
        }
        else
        {
            r.q[0] = a.q[imm & 1];
            r.q[1] = b.q[(imm >> 1) & 1];
        }
        setXmm(reg, &r);
        break;
    }
    case 0xd6:
        /* movq xmm/m64, xmm: a register destination's high half zeroed */
        if (key != 1) { code = X_LEAVE; break; }
        getXmm(&b, reg);
        if (mem) { STORE_M(b, 8); break; }
        b.q[1] = 0;
        setXmm(rm, &b);
        break;
    case 0xd7:
        /* pmovmskb */
        if (key != 1 || mem) { code = X_LEAVE; break; }
        getXmm(&b, rm);
        {
            u32 mask = 0;
            for (u32 i = 0; i < 16; i++) mask |= (u32)(b.b[i] >> 7) << i;
            regs[reg] = mask;
        }
        break;
    case 0xe6:
        getXmm(&a, reg);
        if (key == 2)
        {
            /* cvtdq2pd */
            LOAD_W(b, 8);
            a.q[0] = bitsOf((double)b.sw[0]);
            a.q[1] = bitsOf((double)b.sw[1]);
        }
        else if (key == 1 || key == 3)
        {
            /* cvttpd2dq, cvtpd2dq */
            LOAD_W(b, 16);
            for (u32 i = 0; i < 2; i++)
            {
                double v = fromBits(b.q[i]);
                a.w[i] = floatToInt(key == 3 ? byMxcsr(v) : v, 1);
            }
            a.q[1] = 0;
        }
        else
        {
            code = X_LEAVE;
            break;
        }
        setXmm(reg, &a);
        break;
    case 0xe7:
        /* movntdq */
        if (key != 1 || !mem) { code = X_LEAVE; break; }
        getXmm(&b, reg);
        STORE_M(b, 16);
        break;
    case 0xf0:
        /* lddqu */
        if (key != 3 || !mem) { code = X_LEAVE; break; }
        LOAD_M(b, 16);
        setXmm(reg, &b);
        break;
    default:
        /* The packed integer family, 66 forms: the unpacks, packs, compares and arithmetic. */
        if (key != 1 || !((PACKED_INT[op2 >> 5] >> (op2 & 31)) & 1)) { code = X_LEAVE; break; }
        getXmm(&a, reg);
        LOAD_W(b, 16);
        packedInt(op2, &a, &b);
        setXmm(reg, &a);
        break;
    }
done:
    xLen = len;
    return code;
}

/* Whether a `lock` may stand before the opcode at p (the opcode's next byte):
 * the SDM's LOCK, the forms that read and write memory as one -- whose
 * register forms MODRM leaves. Any other is #UD, the JavaScript tier's to
 * raise. */
static inline u32 lockable(u32 op, const u8 *p)
{
    if (op == 0x0f)
    {
        u32 op2 = p[0], slot = (p[1] >> 3) & 7;
        return op2 == 0xab || op2 == 0xb3 || op2 == 0xbb || (op2 == 0xba && slot >= 5)
            || op2 == 0xb0 || op2 == 0xb1 || op2 == 0xc0 || op2 == 0xc1 || (op2 == 0xc7 && slot == 1);
    }
    u32 slot = (p[0] >> 3) & 7;
    if (op < 0x40) return (op & 7) < 2 && (op >> 3) != 7;
    return ((op == 0x80 || op == 0x81 || op == 0x83) && slot != 7) || op == 0x86 || op == 0x87
        || ((op == 0xf6 || op == 0xf7) && (slot == 2 || slot == 3))
        || ((op == 0xfe || op == 0xff) && slot < 2);
}

#ifdef LONG
/* The high quadword of a 64 by 64 bit product, the low one in *low: the halves
 * multiplied apart, as no wider type holds it without a library call. */
static inline u64 multiplyHigh(u64 a, u64 b, u64 *low)
{
    u64 aLow = (u32)a, aHigh = a >> 32, bLow = (u32)b, bHigh = b >> 32;
    u64 ll = aLow * bLow, lh = aLow * bHigh, hl = aHigh * bLow, hh = aHigh * bHigh;
    u64 middle = (ll >> 32) + (u32)lh + (u32)hl;
    *low = middle << 32 | (u32)ll;
    return hh + (lh >> 32) + (hl >> 32) + (middle >> 32);
}

/* The same signed: the unsigned high half less each operand where the other is negative. */
static inline u64 multiplyHighSigned(i64 a, i64 b, u64 *low)
{
    u64 high = multiplyHigh((u64)a, (u64)b, low);
    if (a < 0) high -= (u64)b;
    if (b < 0) high -= (u64)a;
    return high;
}

/* high:low divided by d where high < d, so the quotient fits: one bit a step,
 * the remainder in *remainder. */
static u64 divide128(u64 high, u64 low, u64 d, u64 *remainder)
{
    if (high == 0)
    {
        *remainder = low % d;
        return low / d;
    }
    u64 q = 0;
    for (u32 i = 0; i < 64; i++)
    {
        u64 carry = high >> 63;
        high = high << 1 | low >> 63;
        low <<= 1;
        q <<= 1;
        if (carry || high >= d)
        {
            high -= d;
            q |= 1;
        }
    }
    *remainder = high;
    return q;
}

/* idiv of high:low by d, both signed: whether the quotient fits a quadword
 * (else #DE), the quotient truncated and the remainder with the dividend's sign. */
static u32 divideSigned128(u64 high, u64 low, u64 d, u64 *quotient, u64 *remainder)
{
    u32 negative = (u32)(high >> 63), negativeDivisor = (u32)(d >> 63);
    if (negative)
    {
        high = ~high + (low == 0);
        low = 0 - low;
    }
    u64 magnitude = negativeDivisor ? 0 - d : d, rest;
    if (high >= magnitude) return 0;
    u64 q = divide128(high, low, magnitude, &rest);
    if (negative != negativeDivisor)
    {
        if (q > SIGN64) return 0;
        q = 0 - q;
    }
    else if (q >= SIGN64) return 0;
    *quotient = q;
    *remainder = negative ? 0 - rest : rest;
    return 1;
}

/* The integer interpreter in long mode, as runInteger below is in 32-bit code. */
__attribute__((noinline))
static u32 runInteger(u32 budget)
{
    u64 rip = *ripField;
    u32 fl = *eflagsField;
    /* The last flag writer, at up to a quadword's width (size index 3). */
    u32 lk = 0, lc = 0;
    u64 lr = 0, la = 0, lb = 0;
    u32 n = 0;
    u32 code;
    u64 start;

#define RECORD(kind, si, r, a, b, c) do { lk = (kind) << 2 | (si); lr = (r); la = (a); lb = (b); lc = (c); } while (0)
#define LEAVE(c) do { code = (c); goto out; } while (0)
#define FAULT(v) do { exitValue = (v); code = W_FAULT; goto out; } while (0)

    for (;;)
    {
        if (n >= budget)
        {
            code = W_BUDGET;
            break;
        }
        start = rip;
        /* As runInteger's, and code whose fifteen bytes could reach 2^32 is the
         * host's to fetch. */
        u32 at = (u32)rip;
        if (rip > WINDOW - 16 || (pageFlags[at >> 12] & (INACCESSIBLE | NO_EXECUTE))
            || ((at & 0xfff) > 0xff0 && (pageFlags[(at + 15) >> 12] & (INACCESSIBLE | NO_EXECUTE))))
        {
            code = W_UNSUPPORTED;
            break;
        }
        const u8 *p = ram + at;
        u32 operand16 = 0, addr32 = 0, rex = 0, hasSeg = 0, rep = 0, lock = 0, len = 0, op;
        u64 seg = 0;
        /* REX counts only right before the opcode: a prefix after it voids it.
         * Four prefix bytes at most, REX among them, keep the longest form
         * within the fifteen bytes the processor allows. */
        for (;;)
        {
            op = p[len++];
            if ((op & 0xf0) == 0x40) rex = op;
            else
            {
                if (op == 0x66) operand16 = 1;
                else if (op == 0x67) addr32 = 1;
                else if (op == 0x64) { seg = *fsBaseField; hasSeg = 1; }
                else if (op == 0x65) { seg = *gsBaseField; hasSeg = 1; }
                else if (op == 0x26 || op == 0x2e || op == 0x36 || op == 0x3e) { }
                else if (op == 0xf3) rep = 1;
                else if (op == 0xf2) rep = 2;
                else if (op == 0xf0) lock = 1;
                else break;
                rex = 0;
            }
            if (len > 4) LEAVE(W_UNSUPPORTED);
        }
        if (lock && (atomic || !lockable(op, p + len))) LEAVE(W_UNSUPPORTED);
        u32 opsize = (rex & 8) ? 8 : operand16 ? 2 : 4, si = SIZE_INDEX(opsize);

        /* The modrm operand: a register (isReg, ea its number) or memory at ea,
         * the whole address; greg is the reg field with REX.R, ext the field
         * alone, a group's opcode. A RIP-relative address counts from the
         * instruction's end, `after` immediate bytes past the addressing ones;
         * the address-size prefix cuts an address to 32 bits before the
         * segment's base is added. */
        u32 modrm, isReg = 0, greg = 0, ext = 0;
        u64 ea = 0;
#define MODRM(after) do { \
            modrm = p[len++]; ext = (modrm >> 3) & 7; greg = ext | ((rex & 4) << 1); \
            if (modrm >= 0xc0) \
            { \
                if (lock) LEAVE(W_UNSUPPORTED); \
                isReg = 1; ea = (modrm & 7) | ((rex & 1) << 3); \
            } \
            else \
            { \
                u32 _mod = modrm >> 6, _rm = modrm & 7; \
                if (_rm == 4) \
                { \
                    u32 _sib = p[len++], _index = ((_sib >> 3) & 7) | ((rex & 2) << 2); \
                    ea = _index != 4 ? regs[_index] << (_sib >> 6) : 0; \
                    if ((_sib & 7) == 5 && _mod == 0) { ea += (u64)(i64)*(i32 *)(p + len); len += 4; } \
                    else ea += regs[(_sib & 7) | ((rex & 1) << 3)]; \
                } \
                else if (_rm == 5 && _mod == 0) \
                { \
                    ea = (u64)(i64)*(i32 *)(p + len); len += 4; \
                    ea += rip + len + (after); \
                } \
                else ea = regs[_rm | ((rex & 1) << 3)]; \
                if (_mod == 1) { ea += (u64)(i64)(i8)p[len]; len += 1; } \
                else if (_mod == 2) { ea += (u64)(i64)*(i32 *)(p + len); len += 4; } \
                if (addr32) ea = (u32)ea; \
                ea += seg; \
            } \
        } while (0)
#define READ_CHECK(a, size) do { u64 _a = (a); \
            if (_a > WINDOW - (size) || touches((u32)_a, (size), INACCESSIBLE)) FAULT(13); } while (0)
        u32 codeWrite = NONE, codeWriteSize = 0;
#define WRITE_CHECK(a, size) do { u64 _w = (a); u32 _a = (u32)_w; \
            if (_w > WINDOW - (size)) FAULT(13); \
            if (touches(_a, (size), INACCESSIBLE | HAS_CODE | WATCH)) \
            { \
                if (touches(_a, (size), INACCESSIBLE)) FAULT(13); \
                if (touches(_a, (size), WATCH)) LEAVE(W_UNSUPPORTED); \
                if (codeHit(_a) || codeHit(_a + (size) - 1)) { codeWrite = _a; codeWriteSize = (size); } \
            } } while (0)
#define RM_READ(size, out) do { \
            if (isReg) out = regOf((u32)ea, size, rex); \
            else { READ_CHECK(ea, size); out = load((u32)ea, size); } } while (0)
#define RM_WRITE(size, v) do { u64 _v = (v); \
            if (isReg) setRegOf((u32)ea, size, rex, _v); \
            else { WRITE_CHECK(ea, size); store((u32)ea, size, _v); } } while (0)
        /* An immediate of an operand's size: a quadword's is four bytes, sign-extended. */
#define IMM(size, out) do { \
            if ((size) == 1) { out = p[len]; len += 1; } \
            else if ((size) == 2) { out = *(u16 *)(p + len); len += 2; } \
            else if ((size) == 4) { out = *(u32 *)(p + len); len += 4; } \
            else { out = (u64)(i64)*(i32 *)(p + len); len += 4; } } while (0)
#define IMM_BYTES(size) ((size) == 8 ? 4 : (size))
#define PUSH(v) do { u64 _v = (v), _at = regs[4] - 8; \
            WRITE_CHECK(_at, 8); *(u64 *)(ram + (u32)_at) = _v; regs[4] = _at; } while (0)
#define POP(out) do { u64 _at = regs[4]; \
            READ_CHECK(_at, 8); out = *(u64 *)(ram + (u32)_at); regs[4] = _at + 8; } while (0)
        /* A stack operation's width: a quadword, a word with the operand-size prefix. */
        u32 stack = operand16 ? 2 : 8;
#define PUSH_AT(v, width) do { u64 _v = (v), _at = regs[4] - (width); \
            WRITE_CHECK(_at, width); store((u32)_at, width, _v); regs[4] = _at; } while (0)
#define POP_AT(out, width) do { u64 _at = regs[4]; \
            READ_CHECK(_at, width); out = load((u32)_at, width); regs[4] = _at + (width); } while (0)

        u64 target = 0, rel = 0, fa = 0, fb = 0;
        u32 jumped = 0, helper, cc = 0;

        switch (op)
        {
        case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05:
        case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d:
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
        case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d:
        case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25:
        case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
        case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d:
        case 0x80: case 0x81: case 0x83:
        {
            u32 aop, size, form;
            u64 a, b;
            if (op >= 0x80)
            {
                size = op == 0x80 ? 1 : opsize;
                MODRM(op == 0x81 ? IMM_BYTES(size) : 1);
                aop = ext;
                if (op == 0x81) IMM(size, b);
                else { b = (u64)(i64)(i8)p[len]; len += 1; }
                RM_READ(size, a);
                form = 0;
            }
            else
            {
                aop = op >> 3;
                form = op & 7;
                size = (form & 1) ? opsize : 1;
                if (form >= 4)
                {
                    a = regOf(0, size, rex);
                    IMM(size, b);
                }
                else
                {
                    MODRM(0);
                    if (form < 2) { RM_READ(size, a); b = regOf(greg, size, rex); }
                    else { a = regOf(greg, size, rex); RM_READ(size, b); }
                }
            }
            u32 s = SIZE_INDEX(size), kind, cin = 0;
            u64 m = MASKS[s], r;
            b &= m;
            switch (aop)
            {
            case 0: r = a + b; kind = L_ADD; break;
            case 1: r = a | b; kind = L_LOGIC; break;
            case 2: FOLD(); cin = fl & CF; r = a + b + cin; kind = L_ADC; break;
            case 3: FOLD(); cin = fl & CF; r = a - b - cin; kind = L_SBB; break;
            case 4: r = a & b; kind = L_LOGIC; break;
            case 5: r = a - b; kind = L_SUB; break;
            case 6: r = a ^ b; kind = L_LOGIC; break;
            default: r = a - b; kind = L_SUB; break;
            }
            r &= m;
            if (aop != 7)
            {
                if (form >= 4) setRegOf(0, size, rex, r);
                else if (form < 2) RM_WRITE(size, r);
                else setRegOf(greg, size, rex, r);
            }
            RECORD(kind, s, r, a, b, cin);
            break;
        }
        case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
            PUSH_AT(regs[(op & 7) | ((rex & 1) << 3)], stack);
            break;
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        {
            /* The register written after rsp moves: pop rsp takes the value. */
            u64 v;
            POP_AT(v, stack);
            setRegOf((op & 7) | ((rex & 1) << 3), stack, rex, v);
            break;
        }
        case 0x63:
        {
            /* movsxd: the dword sign-extended, then written at the operand size. */
            u64 v;
            MODRM(0);
            RM_READ(4, v);
            setRegOf(greg, opsize, rex, (u64)(i64)(i32)v);
            break;
        }
        case 0x68: case 0x6a:
        {
            u64 v;
            if (op == 0x68) IMM(stack, v);
            else { v = (u64)(i64)(i8)p[len]; len += 1; }
            PUSH_AT(v, stack);
            break;
        }
        case 0x69: case 0x6b:
            MODRM(op == 0x69 ? IMM_BYTES(opsize) : 1);
            RM_READ(opsize, fa);
            if (op == 0x69) IMM(opsize, fb);
            else { fb = (u64)(i64)(i8)p[len]; len += 1; }
        multiply:
        {
            u32 f;
            FOLD();
            if (opsize == 8)
            {
                u64 low, high = multiplyHighSigned((i64)fa, (i64)fb, &low);
                regs[greg] = low;
                f = high != (u64)((i64)low >> 63) ? CF | OF : 0;
            }
            else if (opsize == 4)
            {
                i64 product = (i64)(i32)fa * (i64)(i32)fb;
                regs[greg] = (u32)product;
                f = product != (i64)(i32)product ? CF | OF : 0;
            }
            else
            {
                i32 product = (i32)(i16)fa * (i32)(i16)fb;
                setReg16(greg, (u64)(u32)product);
                f = product != (i32)(i16)product ? CF | OF : 0;
            }
            fl = (fl & ~(CF | OF)) | f;
            break;
        }
        case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f:
            rel = (u64)(i64)(i8)p[len];
            cc = op & 15;
            len += 1;
        jcc:
        {
            u32 h;
            if ((cc >> 1) == 2 && lk) h = ((lr & MASKS[lk & 3]) == 0) ^ (cc & 1);
            else if ((lk >> 2) == L_SUB && ((cc >> 1) == 1 || (cc >> 1) == 3 || (cc >> 1) >= 6))
            {
                u32 s = lk & 3, sh = 64 - (8u << s);
                u64 m = MASKS[s], a = la & m, b = lb & m;
                i64 sa = (i64)(a << sh) >> sh, sb = (i64)(b << sh) >> sh;
                switch (cc >> 1)
                {
                case 1: h = a < b; break;
                case 3: h = a <= b; break;
                case 6: h = sa < sb; break;
                default: h = sa <= sb; break;
                }
                h ^= cc & 1;
            }
            else
            {
                FOLD();
                h = holds(cc, fl);
            }
            if (h) { target = rip + len + rel; jumped = 1; }
            break;
        }
        case 0x84: case 0x85: case 0xa8: case 0xa9:
        {
            u32 size = (op & 1) ? opsize : 1;
            u64 a, b;
            if (op >= 0xa8)
            {
                a = regOf(0, size, rex);
                IMM(size, b);
            }
            else
            {
                MODRM(0);
                RM_READ(size, a);
                b = regOf(greg, size, rex);
            }
            b &= MASKS[SIZE_INDEX(size)];
            RECORD(L_LOGIC, SIZE_INDEX(size), a & b, a, b, 0);
            break;
        }
        case 0x86: case 0x87:
        {
            u32 size = (op & 1) ? opsize : 1;
            u64 a, b;
            MODRM(0);
            if (atomic && !isReg) LEAVE(W_UNSUPPORTED);
            RM_READ(size, a);
            b = regOf(greg, size, rex);
            RM_WRITE(size, b);
            setRegOf(greg, size, rex, a);
            break;
        }
        case 0x88: case 0x89:
        {
            u32 size = (op & 1) ? opsize : 1;
            MODRM(0);
            RM_WRITE(size, regOf(greg, size, rex));
            break;
        }
        case 0x8a: case 0x8b:
        {
            u32 size = (op & 1) ? opsize : 1;
            u64 v;
            MODRM(0);
            RM_READ(size, v);
            setRegOf(greg, size, rex, v);
            break;
        }
        case 0x8d:
            /* lea: the address without the segment's base, at the operand size. */
            MODRM(0);
            if (isReg) LEAVE(W_UNSUPPORTED);
            setRegOf(greg, opsize, rex, ea - seg);
            break;
        case 0x8f:
        {
            /* pop r/m: a memory operand is addressed with rsp past the pop, and a
             * store that faults leaves rsp where it was. */
            u64 v, before = regs[4];
            if ((p[len] & 0x38) != 0) LEAVE(W_UNSUPPORTED);
            POP_AT(v, stack);
            MODRM(0);
            if (isReg)
            {
                setRegOf((u32)ea, stack, rex, v);
                break;
            }
            u32 a = (u32)ea;
            if (ea > WINDOW - stack || touches(a, stack, INACCESSIBLE))
            {
                regs[4] = before;
                FAULT(13);
            }
            if (touches(a, stack, WATCH))
            {
                regs[4] = before;
                LEAVE(W_UNSUPPORTED);
            }
            if (touches(a, stack, HAS_CODE) && (codeHit(a) || codeHit(a + stack - 1)))
            {
                codeWrite = a;
                codeWriteSize = stack;
            }
            store(a, stack, v);
            break;
        }
        case 0x90:
            /* nop and pause; with REX.B, xchg r8 and the accumulator. */
            if ((rex & 1) == 0 || rep == 1) break;
            __attribute__((fallthrough));
        case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
        {
            u32 r = (op & 7) | ((rex & 1) << 3);
            u64 t = regOf(0, opsize, rex), u = regOf(r, opsize, rex);
            setRegOf(0, opsize, rex, u);
            setRegOf(r, opsize, rex, t);
            break;
        }
        case 0x98:
            /* cbw, cwde, cdqe */
            if (opsize == 8) regs[0] = (u64)(i64)(i32)regs[0];
            else if (opsize == 4) regs[0] = (u32)(i32)(i16)regs[0];
            else setReg16(0, (u64)(i64)(i8)regs[0]);
            break;
        case 0x99:
            /* cwd, cdq, cqo */
            setRegOf(2, opsize, rex, (regOf(0, opsize, rex) & SIGNS[si]) ? ~0ull : 0);
            break;
        case 0x9b:
            break;
        case 0x9c:
            FOLD();
            PUSH_AT(fl, stack);
            break;
        case 0x9d:
        {
            u64 v;
            u32 w = (0xcd5 | DF | (1u << 11) | (1u << 14) | (1u << 18) | (1u << 21))
                & (operand16 ? 0xffff : 0xffffffff);
            POP_AT(v, stack);
            FOLD();
            fl = (fl & ~w) | ((u32)v & w) | 2;
            break;
        }
        case 0x9e:
            /* sahf and lahf: AH whatever REX says. */
            FOLD();
            fl = (fl & ~0xd5u) | (((u8 *)regs)[1] & 0xd5);
            break;
        case 0x9f:
            FOLD();
            ((u8 *)regs)[1] = (u8)((fl & 0xd5) | 2);
            break;
        case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
            helper = x87(p);
            goto helped;
        case 0xa0: case 0xa1: case 0xa2: case 0xa3:
        {
            /* The moffs forms: an eight-byte address, four with the address-size prefix. */
            u32 size = (op & 1) ? opsize : 1;
            u64 a;
            if (addr32) { a = *(u32 *)(p + len); len += 4; }
            else { a = *(u64 *)(p + len); len += 8; }
            a += seg;
            if (op < 0xa2)
            {
                READ_CHECK(a, size);
                setRegOf(0, size, rex, load((u32)a, size));
            }
            else
            {
                WRITE_CHECK(a, size);
                store((u32)a, size, regOf(0, size, rex));
            }
            break;
        }
        case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad:
        case 0xae: case 0xaf:
        {
            /* As runInteger's: rsi, rdi and rcx whole; esi, edi and ecx are the
             * JavaScript tier's. */
            u32 size = (op & 1) ? opsize : 1, s = SIZE_INDEX(size), kind = op & 0xfe;
            if (hasSeg || addr32) LEAVE(W_UNSUPPORTED);
            FOLD();
            u32 down = (fl & DF) != 0;
            u64 step = down ? 0 - (u64)size : size;
            u32 repeat = rep != 0;
            u32 bulk = repeat && (kind == 0xa4 || kind == 0xaa);
            u32 passing = repeat && (kind == 0xa6 || kind == 0xae);
            for (;;)
            {
                if (repeat && regs[1] == 0) break;
                if (bulk && repeatBulk(kind, size, down) != 0) continue;
                if (passing) passBulk(kind, size, down, rep == 2);
                u32 done = 0;
                if (kind == 0xa4)
                {
                    u64 from = regs[6], to = regs[7];
                    READ_CHECK(from, size);
                    WRITE_CHECK(to, size);
                    store((u32)to, size, load((u32)from, size));
                    regs[6] = from + step;
                    regs[7] = to + step;
                }
                else if (kind == 0xaa)
                {
                    u64 to = regs[7];
                    WRITE_CHECK(to, size);
                    store((u32)to, size, regOf(0, size, rex));
                    regs[7] = to + step;
                }
                else if (kind == 0xac)
                {
                    u64 from = regs[6];
                    READ_CHECK(from, size);
                    setRegOf(0, size, rex, load((u32)from, size));
                    regs[6] = from + step;
                }
                else
                {
                    u64 a, b;
                    if (kind == 0xa6)
                    {
                        READ_CHECK(regs[6], size);
                        READ_CHECK(regs[7], size);
                        a = load((u32)regs[6], size);
                        b = load((u32)regs[7], size);
                        regs[6] += step;
                    }
                    else
                    {
                        READ_CHECK(regs[7], size);
                        a = regOf(0, size, rex);
                        b = load((u32)regs[7], size);
                    }
                    regs[7] += step;
                    u64 r = (a - b) & MASKS[s];
                    RECORD(L_SUB, s, r, a, b, 0);
                    FOLD();
                    done = repeat && ((fl & ZF) != 0) != (rep == 1);
                }
                if (!repeat) break;
                regs[1] -= 1;
                if (done) break;
                if (codeWrite != NONE)
                {
                    if (regs[1] != 0)
                    {
                        exitValue = codeWrite;
                        exitSize = codeWriteSize;
                        code = W_CODE_WRITE;
                        rip = start;
                        goto done;
                    }
                    break;
                }
            }
            break;
        }
        case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
            setReg8((op & 7) | ((rex & 1) << 3), rex, p[len]);
            len += 1;
            break;
        case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        {
            u64 v;
            if (opsize == 8) { v = *(u64 *)(p + len); len += 8; }
            else IMM(opsize, v);
            setRegOf((op & 7) | ((rex & 1) << 3), opsize, rex, v);
            break;
        }
        case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3:
        {
            /* As ir64.js's shift64: a count of zero writes the operand back and no flag. */
            u32 size = (op & 1) ? opsize : 1, count;
            u64 a;
            MODRM(op < 0xc2 ? 1 : 0);
            if (op < 0xc2) { count = p[len]; len += 1; }
            else if (op < 0xd2) count = 1;
            else count = (u32)regs[1] & 0xff;
            RM_READ(size, a);
            count &= size == 8 ? 63 : 31;
            if (count == 0)
            {
                RM_WRITE(size, a);
                break;
            }
            u32 s = SIZE_INDEX(size), bits = size * 8, carry, over, written = ARITH;
            u64 m = MASKS[s], sg = SIGNS[s], r;
            FOLD();
            switch (ext)
            {
            case 4: case 6:
                r = count < bits ? (a << count) & m : 0;
                carry = count <= bits ? (u32)(a >> (bits - count)) & 1 : 0;
                over = ((r & sg) ? 1 : 0) ^ carry;
                break;
            case 5:
                r = count < bits ? (a >> count) & m : 0;
                carry = count <= bits ? (u32)(a >> (count - 1)) & 1 : 0;
                over = (a & sg) ? 1 : 0;
                break;
            case 7:
            {
                i64 v = (i64)(a << (64 - bits)) >> (64 - bits);
                r = (u64)(count < bits ? v >> count : v >> (bits - 1)) & m;
                carry = (u32)(count <= bits ? v >> (count - 1) : v >> (bits - 1)) & 1;
                over = 0;
                break;
            }
            case 0:
            {
                u32 c = count % bits;
                r = c == 0 ? a : ((a << c) | (a >> (bits - c))) & m;
                carry = (u32)r & 1;
                over = ((r & sg) ? 1 : 0) ^ carry;
                written = CF | OF;
                break;
            }
            case 1:
            {
                u32 c = count % bits;
                r = c == 0 ? a : ((a >> c) | (a << (bits - c))) & m;
                carry = (r & sg) ? 1 : 0;
                over = carry ^ ((r & (sg >> 1)) ? 1 : 0);
                written = CF | OF;
                break;
            }
            case 2:
            {
                u32 c = count % (bits + 1), cin = fl & CF;
                r = a;
                for (u32 i = 0; i < c; i++)
                {
                    u32 top = (r & sg) ? 1 : 0;
                    r = ((r << 1) | cin) & m;
                    cin = top;
                }
                carry = cin;
                over = ((r & sg) ? 1 : 0) ^ carry;
                written = CF | OF;
                break;
            }
            default:
            {
                u32 c = count % (bits + 1), cin = fl & CF;
                over = ((a & sg) ? 1 : 0) ^ cin;
                r = a;
                for (u32 i = 0; i < c; i++)
                {
                    u32 low = (u32)r & 1;
                    r = ((r >> 1) | ((u64)cin << (bits - 1))) & m;
                    cin = low;
                }
                carry = cin;
                written = CF | OF;
                break;
            }
            }
            RM_WRITE(size, r);
            u32 f = (carry ? CF : 0) | (over ? OF : 0);
            if (written == ARITH) f |= resultFlags(r, s);
            fl = (fl & ~written) | f;
            break;
        }
        case 0xc2: case 0xc3:
        {
            u64 extra = 0;
            POP(target);
            if (op == 0xc2)
            {
                IMM(2, extra);
                regs[4] += extra;
            }
            jumped = 1;
            break;
        }
        case 0xc6: case 0xc7:
        {
            u32 size = (op & 1) ? opsize : 1;
            u64 v;
            MODRM(IMM_BYTES(size));
            if (ext != 0) LEAVE(W_UNSUPPORTED);
            IMM(size, v);
            RM_WRITE(size, v);
            break;
        }
        case 0xc9:
        {
            u64 at = regs[5], v;
            if (operand16) LEAVE(W_UNSUPPORTED);
            READ_CHECK(at, 8);
            v = *(u64 *)(ram + (u32)at);
            regs[4] = at + 8;
            regs[5] = v;
            break;
        }
        case 0xe0: case 0xe1: case 0xe2: case 0xe3:
        {
            /* The count is rcx, ecx with the address-size prefix, written zero-extended. */
            u64 offset = (u64)(i64)(i8)p[len], count = addr32 ? (u32)regs[1] : regs[1];
            u32 h;
            len += 1;
            if (op == 0xe3) h = count == 0;
            else
            {
                count -= 1;
                if (addr32) count = (u32)count;
                regs[1] = count;
                if (count == 0 || op == 0xe2) h = count != 0;
                else
                {
                    FOLD();
                    h = ((fl & ZF) != 0) == (op == 0xe1);
                }
            }
            if (h) { target = rip + len + offset; jumped = 1; }
            break;
        }
        case 0xe6: case 0xe7: case 0xee: case 0xef:
        {
            u32 port;
            if (op < 0xee) { port = p[len]; len += 1; }
            else port = (u32)regs[2] & 0xffff;
            if (port != trapPort) LEAVE(W_UNSUPPORTED);
            exitValue = (op & 1) ? (u32)regOf(0, opsize, rex) : (u32)regs[0] & 0xff;
            rip += len;
            n++;
            code = W_TRAP;
            goto done;
        }
        case 0xe8: case 0xe9: case 0xeb:
            /* The near branches are 64 bits whatever an operand-size prefix says. */
            if (op == 0xeb) { rel = (u64)(i64)(i8)p[len]; len += 1; }
            else IMM(8, rel);
            target = rip + len + rel;
            if (op == 0xe8) PUSH(rip + len);
            jumped = 1;
            break;
        case 0xf4:
            rip += len;
            n++;
            code = W_HALT;
            goto done;
        case 0xf5: FOLD(); fl ^= CF; break;
        case 0xf8: FOLD(); fl &= ~CF; break;
        case 0xf9: FOLD(); fl |= CF; break;
        case 0xfc: fl &= ~DF; break;
        case 0xfd: fl |= DF; break;
        case 0xf6: case 0xf7:
        {
            u32 size = (op & 1) ? opsize : 1, s = SIZE_INDEX(size);
            u64 m = MASKS[s], a;
            MODRM(ext <= 1 ? IMM_BYTES(size) : 0);
            if (ext <= 1)
            {
                u64 b;
                IMM(size, b);
                RM_READ(size, a);
                b &= m;
                RECORD(L_LOGIC, s, a & b, a, b, 0);
                break;
            }
            RM_READ(size, a);
            switch (ext)
            {
            case 2:
                RM_WRITE(size, ~a & m);
                break;
            case 3:
            {
                u64 r = (0 - a) & m;
                RM_WRITE(size, r);
                RECORD(L_SUB, s, r, 0, a, 0);
                break;
            }
            case 4:
            {
                u64 high;
                FOLD();
                if (size == 8)
                {
                    u64 low;
                    high = multiplyHigh(regs[0], a, &low);
                    regs[0] = low;
                    regs[2] = high;
                }
                else if (size == 4)
                {
                    u64 product = (u64)(u32)regs[0] * a;
                    regs[0] = (u32)product;
                    regs[2] = high = product >> 32;
                }
                else if (size == 2)
                {
                    u64 product = reg16(0) * a;
                    setReg16(0, product);
                    setReg16(2, high = product >> 16);
                }
                else
                {
                    u64 product = (u8)regs[0] * a;
                    setReg16(0, product);
                    high = product >> 8;
                }
                fl = (fl & ~(CF | OF)) | (high ? CF | OF : 0);
                break;
            }
            case 5:
            {
                u32 fits;
                FOLD();
                if (size == 8)
                {
                    u64 low, high = multiplyHighSigned((i64)regs[0], (i64)a, &low);
                    regs[0] = low;
                    regs[2] = high;
                    fits = high == (u64)((i64)low >> 63);
                }
                else if (size == 4)
                {
                    i64 product = (i64)(i32)regs[0] * (i32)a;
                    regs[0] = (u32)product;
                    regs[2] = (u32)((u64)product >> 32);
                    fits = product == (i64)(i32)product;
                }
                else if (size == 2)
                {
                    i32 product = (i16)reg16(0) * (i16)a;
                    setReg16(0, (u32)product);
                    setReg16(2, (u32)product >> 16);
                    fits = product == (i16)product;
                }
                else
                {
                    i32 product = (i8)regs[0] * (i8)a;
                    setReg16(0, (u32)product);
                    fits = product == (i8)product;
                }
                fl = (fl & ~(CF | OF)) | (fits ? 0 : CF | OF);
                break;
            }
            case 6:
                if (a == 0) FAULT(0);
                if (size == 8)
                {
                    u64 rest;
                    if (regs[2] >= a) FAULT(0);
                    regs[0] = divide128(regs[2], regs[0], a, &rest);
                    regs[2] = rest;
                }
                else if (size == 4)
                {
                    u64 dividend = (u64)(u32)regs[2] << 32 | (u32)regs[0], q = dividend / a;
                    if (q > 0xffffffffull) FAULT(0);
                    regs[0] = (u32)q;
                    regs[2] = (u32)(dividend % a);
                }
                else if (size == 2)
                {
                    u32 dividend = (u32)reg16(2) << 16 | (u32)reg16(0), q = dividend / (u32)a;
                    if (q > 0xffff) FAULT(0);
                    setReg16(0, q);
                    setReg16(2, dividend % (u32)a);
                }
                else
                {
                    u32 dividend = (u32)reg16(0), q = dividend / (u32)a;
                    if (q > 0xff) FAULT(0);
                    setReg16(0, (dividend % (u32)a) << 8 | q);
                }
                break;
            default:
                if (a == 0) FAULT(0);
                if (size == 8)
                {
                    u64 q, rest;
                    if (!divideSigned128(regs[2], regs[0], a, &q, &rest)) FAULT(0);
                    regs[0] = q;
                    regs[2] = rest;
                }
                else if (size == 4)
                {
                    i64 dividend = (i64)((u64)(u32)regs[2] << 32 | (u32)regs[0]), divisor = (i32)a;
                    if (dividend == (i64)SIGN64 && divisor == -1) FAULT(0);
                    i64 q = dividend / divisor;
                    if (q != (i64)(i32)q) FAULT(0);
                    regs[0] = (u32)q;
                    regs[2] = (u32)(dividend % divisor);
                }
                else if (size == 2)
                {
                    i32 dividend = (i32)((u32)reg16(2) << 16 | (u32)reg16(0)), divisor = (i16)a;
                    if (dividend == (i32)0x80000000 && divisor == -1) FAULT(0);
                    i32 q = dividend / divisor;
                    if (q != (i16)q) FAULT(0);
                    setReg16(0, (u32)q);
                    setReg16(2, (u32)(dividend % divisor));
                }
                else
                {
                    i32 dividend = (i16)reg16(0), divisor = (i8)a, q = dividend / divisor;
                    if (q != (i8)q) FAULT(0);
                    setReg16(0, ((u32)(dividend % divisor) & 0xff) << 8 | ((u32)q & 0xff));
                }
                break;
            }
            break;
        }
        case 0xfe: case 0xff:
        {
            u32 size = (op & 1) ? opsize : 1;
            u64 a;
            MODRM(0);
            if (ext <= 1)
            {
                RM_READ(size, a);
                u32 s = SIZE_INDEX(size);
                u64 v = (ext == 0 ? a + 1 : a - 1) & MASKS[s];
                FOLD();
                RM_WRITE(size, v);
                RECORD(ext == 0 ? L_INC : L_DEC, s, v, a, 1, 0);
                break;
            }
            /* call, jmp and push take a quadword: the first two whatever an
             * operand-size prefix says, push a word with one. */
            if (op == 0xfe || ext == 3 || ext == 5 || ext == 7) LEAVE(W_UNSUPPORTED);
            if (ext == 6)
            {
                RM_READ(stack, a);
                PUSH_AT(a, stack);
                break;
            }
            RM_READ(8, a);
            if (ext == 2) PUSH(rip + len);
            target = a;
            jumped = 1;
            break;
        }
        case 0x0f:
        {
            u32 op2 = p[len++];
            if (rep == 1 && op2 == 0xb8)
            {
                /* popcnt */
                u64 v;
                MODRM(0);
                RM_READ(opsize, v);
                setRegOf(greg, opsize, rex, (u64)__builtin_popcountll(v));
                FOLD();
                fl = (fl & ~ARITH) | (v == 0 ? ZF : 0);
                break;
            }
            if (rep) goto simd;
            if (op2 >= 0x80 && op2 <= 0x8f)
            {
                IMM(8, rel);
                cc = op2 & 15;
                goto jcc;
            }
            if (op2 >= 0x90 && op2 <= 0x9f)
            {
                MODRM(0);
                FOLD();
                RM_WRITE(1, holds(op2 & 15, fl));
                break;
            }
            if (op2 >= 0x40 && op2 <= 0x4f)
            {
                /* The source is read, and a dword destination zero-extended, even
                 * when nothing moves. */
                u64 v;
                MODRM(0);
                RM_READ(opsize, v);
                FOLD();
                if (holds(op2 & 15, fl)) setRegOf(greg, opsize, rex, v);
                else if (opsize == 4) regs[greg] = (u32)regs[greg];
                break;
            }
            switch (op2)
            {
            case 0x1f:
                MODRM(0);
                break;
            case 0xaf:
                MODRM(0);
                fa = regOf(greg, opsize, rex);
                RM_READ(opsize, fb);
                goto multiply;
            case 0xb6: case 0xb7: case 0xbe: case 0xbf:
            {
                u32 from = (op2 & 1) ? 2 : 1;
                u64 v;
                MODRM(0);
                RM_READ(from, v);
                if (op2 >= 0xbe) v = from == 1 ? (u64)(i64)(i8)v : (u64)(i64)(i16)v;
                setRegOf(greg, opsize, rex, v);
                break;
            }
            case 0xa3: case 0xab: case 0xb3: case 0xbb: case 0xba:
            {
                /* bt bts btr btc: a register offset reaches past a memory operand,
                 * the floor of its signed bit number over the operand's bits away. */
                u32 bits = opsize * 8, shift = 3 + si, kind;
                u64 offset, a;
                MODRM(op2 == 0xba ? 1 : 0);
                if (op2 == 0xba)
                {
                    if (ext < 4) LEAVE(W_UNSUPPORTED);
                    kind = ext & 3;
                    offset = p[len] & (bits - 1);
                    len += 1;
                }
                else
                {
                    kind = (op2 >> 3) & 3;
                    offset = regOf(greg, opsize, rex);
                    if (!isReg)
                    {
                        i64 signedOffset = (i64)(offset << (64 - bits)) >> (64 - bits);
                        ea += (u64)(signedOffset >> shift) * opsize;
                        offset = (u64)signedOffset & (bits - 1);
                    }
                    else offset &= bits - 1;
                }
                RM_READ(opsize, a);
                u32 bit = (u32)(a >> offset) & 1;
                if (kind == 1) RM_WRITE(opsize, a | (1ull << offset));
                else if (kind == 2) RM_WRITE(opsize, a & ~(1ull << offset));
                else if (kind == 3) RM_WRITE(opsize, a ^ (1ull << offset));
                FOLD();
                fl = (fl & ~CF) | bit;
                break;
            }
            case 0xbc: case 0xbd:
            {
                /* A zero source sets ZF and leaves the destination whole. */
                u64 v;
                MODRM(0);
                RM_READ(opsize, v);
                FOLD();
                if (v == 0)
                {
                    fl |= ZF;
                    break;
                }
                setRegOf(greg, opsize, rex, op2 == 0xbc ? (u64)__builtin_ctzll(v) : 63 - (u64)__builtin_clzll(v));
                fl &= ~ZF;
                break;
            }
            case 0xa4: case 0xa5: case 0xac: case 0xad:
            {
                /* shld and shrd as ir64.js has them: a count of zero writes the
                 * destination back, and a word's count past sixteen shifts the
                 * source on through it. */
                u32 bits = opsize * 8, count;
                u64 m = MASKS[si], a, b, r;
                u32 carry;
                MODRM((op2 & 1) == 0 ? 1 : 0);
                if ((op2 & 1) == 0) { count = p[len]; len += 1; }
                else count = (u32)regs[1] & 0xff;
                count &= opsize == 8 ? 63 : 31;
                RM_READ(opsize, a);
                b = regOf(greg, opsize, rex);
                if (count == 0)
                {
                    RM_WRITE(opsize, a);
                    break;
                }
                if (op2 < 0xac)
                {
                    r = ((a << count) | (count <= bits ? b >> (bits - count) : b << (count - bits))) & m;
                    carry = (u32)(count <= bits ? a >> (bits - count) : a << (count - bits)) & 1;
                }
                else
                {
                    r = ((a >> count) | (count <= bits ? b << (bits - count) : b >> (count - bits))) & m;
                    carry = (u32)(a >> (count - 1)) & 1;
                }
                RM_WRITE(opsize, r);
                FOLD();
                fl = (fl & ~ARITH) | (carry ? CF : 0) | (((a ^ r) & SIGNS[si]) ? OF : 0) | resultFlags(r, si);
                break;
            }
            case 0xb0: case 0xb1:
            {
                /* A memory destination is written back with what it held when the
                 * compare fails; a register one is left whole. */
                u32 size = (op2 & 1) ? opsize : 1, s = SIZE_INDEX(size);
                u64 d, acc;
                MODRM(0);
                RM_READ(size, d);
                acc = regOf(0, size, rex);
                if (acc == d) RM_WRITE(size, regOf(greg, size, rex));
                else
                {
                    if (!isReg) RM_WRITE(size, d);
                    setRegOf(0, size, rex, d);
                }
                RECORD(L_SUB, s, (acc - d) & MASKS[s], acc, d, 0);
                break;
            }
            case 0xc0: case 0xc1:
            {
                u32 size = (op2 & 1) ? opsize : 1, s = SIZE_INDEX(size);
                u64 a, b, r;
                MODRM(0);
                RM_READ(size, a);
                b = regOf(greg, size, rex);
                r = (a + b) & MASKS[s];
                if (isReg) { setRegOf(greg, size, rex, a); setRegOf((u32)ea, size, rex, r); }
                else { WRITE_CHECK(ea, size); setRegOf(greg, size, rex, a); store((u32)ea, size, r); }
                RECORD(L_ADD, s, r, a, b, 0);
                break;
            }
            case 0xc7:
            {
                /* cmpxchg8b, and with REX.W cmpxchg16b, whose operand must be
                 * aligned; what memory held is written back when they differ. */
                u32 half = opsize == 8 ? 8 : 4;
                u64 low, high;
                MODRM(0);
                if (isReg || ext != 1 || operand16 || atomic) LEAVE(W_UNSUPPORTED);
                if (half == 8 && (ea & 15) != 0) FAULT(13);
                READ_CHECK(ea, half * 2);
                low = load((u32)ea, half);
                high = load((u32)ea + half, half);
                WRITE_CHECK(ea, half * 2);
                FOLD();
                if (low == regOf(0, half, rex) && high == regOf(2, half, rex))
                {
                    store((u32)ea, half, regs[3]);
                    store((u32)ea + half, half, regs[1]);
                    fl |= ZF;
                }
                else
                {
                    store((u32)ea, half, low);
                    store((u32)ea + half, half, high);
                    setRegOf(0, half, rex, low);
                    setRegOf(2, half, rex, high);
                    fl &= ~ZF;
                }
                break;
            }
            case 0xc8: case 0xc9: case 0xca: case 0xcb: case 0xcc: case 0xcd: case 0xce: case 0xcf:
            {
                u32 r = (op2 & 7) | ((rex & 1) << 3);
                if (operand16) LEAVE(W_UNSUPPORTED);
                if (opsize == 8) regs[r] = __builtin_bswap64(regs[r]);
                else regs[r] = __builtin_bswap32((u32)regs[r]);
                break;
            }
            default:
            simd:
                helper = sse(p);
                goto helped;
            }
            break;
        }
        default:
            LEAVE(W_UNSUPPORTED);
        helped:
            if (helper == X_LEAVE) LEAVE(W_UNSUPPORTED);
            if (helper == X_FAULT) FAULT(13);
            len = xLen;
            if (helper == X_FLAGS)
            {
                lk = 0;
                fl = (fl & ~ARITH) | xFlags;
            }
            if (xWrite != NONE)
            {
                codeWrite = xWrite;
                codeWriteSize = xWriteSize;
            }
            break;
        }
        n++;
        if (jumped)
        {
            rip = target;
            /* As runInteger's, for a target in the window: one past it is the
             * host's to fault at the next fetch. */
            if ((target >> 32) == 0)
            {
                u32 to = (u32)target;
                if (to - parkBase > 2)
                {
                    starts[*startAt & 255] = to;
                    *startAt += 1;
                }
                u8 *count = hotCounts + ((to >> 2) & hotMask);
                u32 c = *count;
                if (c < 255) *count = (u8)++c;
                if (c >= hotThreshold && (c & (c - 1)) == 0)
                {
                    exitValue = c;
                    code = W_HOT;
                    goto done;
                }
                u32 slot = (to * 0x9e3779b1u) >> hashShift;
                for (;;)
                {
                    u32 key = *(u32 *)(hash + slot * 12);
                    if (key == 0) break;
                    if (key == to)
                    {
                        code = W_ENTRY;
                        goto done;
                    }
                    slot = (slot + 1) & ((1u << (32 - hashShift)) - 1);
                }
            }
        }
        else
        {
            rip += len;
        }
        if (codeWrite != NONE)
        {
            exitValue = codeWrite;
            exitSize = codeWriteSize;
            code = W_CODE_WRITE;
            goto done;
        }
        continue;
    out:
        rip = start;
        goto done;
    }
done:
    FOLD();
    *ripField = rip;
    *eflagsField = fl;
    retired = n;
    return code;
}

#undef RECORD
#undef LEAVE
#undef FAULT
#undef MODRM
#undef READ_CHECK
#undef WRITE_CHECK
#undef RM_READ
#undef RM_WRITE
#undef IMM
#undef IMM_BYTES
#undef PUSH
#undef POP
#undef PUSH_AT
#undef POP_AT
#else
/* The integer interpreter: its loop calls a float helper with nothing of its
 * flags, and leaves at what needs them folded. */
__attribute__((noinline))
static u32 runInteger(u32 budget)
{
    u32 eip = *eipField;
    u32 fl = *eflagsField;
    /* The last flag writer: while lk is not zero the arithmetic bits of fl are stale
     * (all but CF after inc/dec, which keeps it). */
    u32 lk = 0, lr = 0, la = 0, lb = 0, lc = 0;
    u32 n = 0;
    u32 code;
    u32 start;

#define RECORD(kind, si, r, a, b, c) do { lk = (kind) << 2 | (si); lr = (r); la = (a); lb = (b); lc = (c); } while (0)
#define LEAVE(c) do { code = (c); goto out; } while (0)
#define FAULT(v) do { exitValue = (v); code = W_FAULT; goto out; } while (0)

    for (;;)
    {
        if (n >= budget)
        {
            code = W_BUDGET;
            break;
        }
        start = eip;
        /* A fetch within one page that runs, or across into one that does; anything
         * else -- a page no-access, or one that only reads, as the null range does --
         * is the host's to fault. */
        if ((pageFlags[eip >> 12] & (INACCESSIBLE | NO_EXECUTE))
            || ((eip & 0xfff) > 0xff0
                && (pageFlags[(eip + 15) >> 12] & (INACCESSIBLE | NO_EXECUTE))))
        {
            code = W_UNSUPPORTED;
            break;
        }
        const u8 *p = ram + eip;
        u32 opsize = 4, seg = 0, hasSeg = 0, rep = 0, lock = 0, len = 0, op;
        for (;;)
        {
            op = p[len++];
            if (op == 0x66) opsize = 2;
            else if (op == 0x64) { seg = *fsBaseField; hasSeg = 1; }
            else if (op == 0x26 || op == 0x2e || op == 0x36 || op == 0x3e) { }
            else if (op == 0xf3) rep = 1;
            else if (op == 0xf2) rep = 2;
            else if (op == 0xf0) lock = 1;
            else break;
            if (len > 4) LEAVE(W_UNSUPPORTED);
        }
        if (op == 0x65 || op == 0x67) LEAVE(W_UNSUPPORTED);
        if (lock && (atomic || !lockable(op, p + len))) LEAVE(W_UNSUPPORTED);
        u32 si = SIZE_INDEX(opsize);

        /* The modrm operand: a register (isReg, ea its number) or memory at ea. */
        u32 modrm, isReg = 0, ea = 0, greg = 0;
#define MODRM() do { \
            modrm = p[len++]; greg = (modrm >> 3) & 7; \
            if (modrm >= 0xc0) { isReg = 1; ea = modrm & 7; } \
            else \
            { \
                u32 _mod = modrm >> 6, _rm = modrm & 7; ea = 0; \
                if (_rm == 4) \
                { \
                    u32 _sib = p[len++], _base = _sib & 7, _index = (_sib >> 3) & 7; \
                    if (_index != 4) ea = regs[_index] << (_sib >> 6); \
                    if (_base == 5 && _mod == 0) { ea += *(u32 *)(p + len); len += 4; } \
                    else ea += regs[_base]; \
                } \
                else if (_rm == 5 && _mod == 0) { ea = *(u32 *)(p + len); len += 4; } \
                else ea = regs[_rm]; \
                if (_mod == 1) { ea += (u32)(i32)(i8)p[len]; len += 1; } \
                else if (_mod == 2) { ea += *(u32 *)(p + len); len += 4; } \
                ea += seg; \
            } \
        } while (0)
#define READ_CHECK(a, size) do { if (touches((a), (size), INACCESSIBLE)) FAULT(13); } while (0)
        /* A store's page test: a fault before it, a note of translated code for after it. */
        u32 codeWrite = NONE, codeWriteSize = 0;
#define WRITE_CHECK(a, size) do { u32 _a = (a); \
            if (touches(_a, (size), INACCESSIBLE | HAS_CODE | WATCH)) \
            { \
                if (touches(_a, (size), INACCESSIBLE)) FAULT(13); \
                if (touches(_a, (size), WATCH)) LEAVE(W_UNSUPPORTED); \
                if (codeHit(_a) || codeHit(_a + (size) - 1)) { codeWrite = _a; codeWriteSize = (size); } \
            } } while (0)
#define RM_READ(size, out) do { \
            if (isReg) out = regOf(ea, size); \
            else { READ_CHECK(ea, size); out = load(ea, size); } } while (0)
#define RM_WRITE(size, v) do { u32 _v = (v); \
            if (isReg) setRegOf(ea, size, _v); \
            else { WRITE_CHECK(ea, size); store(ea, size, _v); } } while (0)
#define IMM(size, out) do { \
            if ((size) == 1) { out = p[len]; len += 1; } \
            else if ((size) == 2) { out = *(u16 *)(p + len); len += 2; } \
            else { out = *(u32 *)(p + len); len += 4; } } while (0)
#define PUSH(v) do { u32 _v = (v), _at = regs[4] - 4; \
            WRITE_CHECK(_at, 4); *(u32 *)(ram + _at) = _v; regs[4] = _at; } while (0)

        u32 target = 0, jumped = 0, helper;
        /* Shared by the paths that join below: a branch's offset and condition, and a
         * two-operand multiply's factors. */
        u32 rel = 0, cc = 0, fa = 0, fb = 0;

        switch (op)
        {
        case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05:
        case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d:
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
        case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d:
        case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25:
        case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
        case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d:
        case 0x80: case 0x81: case 0x83:
        {
            /* The arithmetic block: add or adc sbb and sub xor cmp. `form` 0/1 writes
             * the r/m operand, 2/3 the register, 4/5 the accumulator. */
            u32 aop, size, a, b, form;
            if (op >= 0x80)
            {
                MODRM();
                if (lock && isReg) LEAVE(W_UNSUPPORTED);
                aop = greg;
                size = op == 0x80 ? 1 : opsize;
                if (op == 0x81) IMM(opsize, b);
                else { b = (u32)(i32)(i8)p[len]; len += 1; }
                RM_READ(size, a);
                form = 0;
            }
            else
            {
                aop = op >> 3;
                form = op & 7;
                size = (form & 1) ? opsize : 1;
                if (form >= 4)
                {
                    if (lock) LEAVE(W_UNSUPPORTED);
                    a = regOf(0, size);
                    IMM(size, b);
                }
                else
                {
                    MODRM();
                    if (lock && isReg) LEAVE(W_UNSUPPORTED);
                    if (form < 2) { RM_READ(size, a); b = regOf(greg, size); }
                    else { a = regOf(greg, size); RM_READ(size, b); }
                }
            }
            u32 s = SIZE_INDEX(size), m = MASKS[s], r, kind, cin = 0;
            b &= m;
            switch (aop)
            {
            case 0: r = a + b; kind = L_ADD; break;
            case 1: r = a | b; kind = L_LOGIC; break;
            case 2: FOLD(); cin = fl & CF; r = a + b + cin; kind = L_ADC; break;
            case 3: FOLD(); cin = fl & CF; r = a - b - cin; kind = L_SBB; break;
            case 4: r = a & b; kind = L_LOGIC; break;
            case 5: r = a - b; kind = L_SUB; break;
            case 6: r = a ^ b; kind = L_LOGIC; break;
            default: r = a - b; kind = L_SUB; break;
            }
            r &= m;
            if (aop != 7)
            {
                if (form >= 4) setRegOf(0, size, r);
                else if (form < 2) RM_WRITE(size, r);
                else setRegOf(greg, size, r);
            }
            RECORD(kind, s, r, a, b, cin);
            break;
        }
        case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
        case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f:
        {
            u32 r = op & 7, a = regOf(r, opsize), v = (op < 0x48 ? a + 1 : a - 1) & MASKS[si];
            /* CF is kept: the record before is folded so fl holds it. */
            FOLD();
            setRegOf(r, opsize, v);
            RECORD(op < 0x48 ? L_INC : L_DEC, si, v, a, 1, 0);
            break;
        }
        case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            PUSH(regs[op & 7]);
            break;
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        {
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 at = regs[4];
            READ_CHECK(at, 4);
            u32 v = *(u32 *)(ram + at);
            regs[4] = at + 4;
            regs[op & 7] = v;
            break;
        }
        case 0x60:
        {
            /* pushad: all eight stores tested before any, so a fault leaves the registers. */
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 esp = regs[4], at = esp - 32;
            if (touches(at, 32, INACCESSIBLE | HAS_CODE | WATCH)) LEAVE(W_UNSUPPORTED);
            for (u32 i = 0; i < 8; i++) *(u32 *)(ram + esp - 4 * (i + 1)) = i == 4 ? esp : regs[i];
            regs[4] = at;
            break;
        }
        case 0x61:
        {
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 at = regs[4];
            if (touches(at, 32, INACCESSIBLE)) LEAVE(W_UNSUPPORTED);
            for (u32 i = 0; i < 8; i++) if (i != 3) regs[7 - i] = *(u32 *)(ram + at + 4 * i);
            regs[4] = at + 32;
            break;
        }
        case 0x68: case 0x6a:
        {
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 v;
            if (op == 0x68) IMM(4, v);
            else { v = (u32)(i32)(i8)p[len]; len += 1; }
            PUSH(v);
            break;
        }
        case 0x69: case 0x6b:
            MODRM();
            RM_READ(opsize, fa);
            if (op == 0x69) IMM(opsize, fb);
            else { fb = (u32)(i32)(i8)p[len]; len += 1; }
        multiply:
        {
            u32 f;
            FOLD();
            if (opsize == 4)
            {
                i64 product = (i64)(i32)fa * (i64)(i32)fb;
                regs[greg] = (u32)product;
                f = product != (i64)(i32)product ? CF | OF : 0;
            }
            else
            {
                i32 product = (i32)(i16)fa * (i32)(i16)fb;
                setReg16(greg, (u32)product);
                f = product != (i32)(i16)product ? CF | OF : 0;
            }
            fl = (fl & ~(CF | OF)) | f;
            break;
        }
        case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f:
            rel = (u32)(i32)(i8)p[len];
            cc = op & 15;
            len += 1;
        jcc:
        {
            u32 h;
            /* The common tests read the record without folding it. */
            if ((cc >> 1) == 2 && lk) h = ((lr & MASKS[lk & 3]) == 0) ^ (cc & 1);
            else if ((lk >> 2) == L_SUB && ((cc >> 1) == 1 || (cc >> 1) == 3 || (cc >> 1) >= 6))
            {
                u32 s = lk & 3, m = MASKS[s], a = la & m, b = lb & m, sh = 32 - 8 * (s == 2 ? 4 : s + 1);
                i32 sa = (i32)(a << sh) >> sh, sb = (i32)(b << sh) >> sh;
                switch (cc >> 1)
                {
                case 1: h = a < b; break;
                case 3: h = a <= b; break;
                case 6: h = sa < sb; break;
                default: h = sa <= sb; break;
                }
                h ^= cc & 1;
            }
            else
            {
                FOLD();
                h = holds(cc, fl);
            }
            if (h) { target = eip + len + rel; jumped = 1; }
            break;
        }
        case 0x84: case 0x85: case 0xa8: case 0xa9:
        {
            u32 size = (op & 1) ? opsize : 1, a, b;
            if (op >= 0xa8)
            {
                if (lock) LEAVE(W_UNSUPPORTED);
                a = regOf(0, size);
                IMM(size, b);
            }
            else
            {
                MODRM();
                if (lock) LEAVE(W_UNSUPPORTED);
                RM_READ(size, a);
                b = regOf(greg, size);
            }
            RECORD(L_LOGIC, SIZE_INDEX(size), a & b, a, b, 0);
            break;
        }
        case 0x86: case 0x87:
        {
            u32 size = (op & 1) ? opsize : 1, a, b;
            MODRM();
            if ((lock && isReg) || (atomic && !isReg)) LEAVE(W_UNSUPPORTED);
            RM_READ(size, a);
            b = regOf(greg, size);
            RM_WRITE(size, b);
            setRegOf(greg, size, a);
            break;
        }
        case 0x88: case 0x89:
        {
            u32 size = (op & 1) ? opsize : 1;
            MODRM();
            if (lock) LEAVE(W_UNSUPPORTED);
            RM_WRITE(size, regOf(greg, size));
            break;
        }
        case 0x8a: case 0x8b:
        {
            u32 size = (op & 1) ? opsize : 1, v;
            MODRM();
            if (lock) LEAVE(W_UNSUPPORTED);
            RM_READ(size, v);
            setRegOf(greg, size, v);
            break;
        }
        case 0x8d:
            MODRM();
            /* lea with fs: adds the base in cork's model; the JavaScript tier has it. */
            if (isReg || lock || hasSeg) LEAVE(W_UNSUPPORTED);
            setRegOf(greg, opsize, ea);
            break;
        case 0x8f:
        {
            MODRM();
            /* pop into memory addresses it after the pop: the JavaScript tier's. */
            if (greg != 0 || opsize != 4 || !isReg) LEAVE(W_UNSUPPORTED);
            u32 at = regs[4];
            READ_CHECK(at, 4);
            u32 v = *(u32 *)(ram + at);
            regs[4] = at + 4;
            regs[ea] = v;
            break;
        }
        case 0x90:
            /* nop, pause, and the 66 90 filler. */
            break;
        case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
        {
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 t = regs[0];
            regs[0] = regs[op & 7];
            regs[op & 7] = t;
            break;
        }
        case 0x98:
            if (opsize == 4) regs[0] = (u32)(i32)(i16)regs[0];
            else setReg16(0, (u32)(i32)(i8)regs[0]);
            break;
        case 0x99:
            if (opsize == 4) regs[2] = (regs[0] & 0x80000000) ? 0xffffffff : 0;
            else setReg16(2, (regs[0] & 0x8000) ? 0xffff : 0);
            break;
        case 0x9c:
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            FOLD();
            PUSH(fl);
            break;
        case 0x9d:
        {
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 at = regs[4];
            READ_CHECK(at, 4);
            u32 v = *(u32 *)(ram + at), w = 0xcd5 | DF | (1u << 11) | (1u << 14) | (1u << 18) | (1u << 21);
            regs[4] = at + 4;
            lk = 0;
            fl = (fl & ~w) | (v & w) | 2;
            break;
        }
        case 0x9e:
            FOLD();
            fl = (fl & ~0xd5u) | (reg8(4) & 0xd5);
            break;
        case 0x9f:
            FOLD();
            setReg8(4, (fl & 0xd5) | 2);
            break;
        case 0x9b:
            /* fwait: no exception is ever pending. */
            break;
        case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
            helper = x87(p);
            goto helped;
        case 0xa0: case 0xa1: case 0xa2: case 0xa3:
        {
            u32 size = (op & 1) ? opsize : 1, a;
            IMM(4, a);
            a += seg;
            if (op < 0xa2)
            {
                READ_CHECK(a, size);
                setRegOf(0, size, load(a, size));
            }
            else
            {
                WRITE_CHECK(a, size);
                store(a, size, regOf(0, size));
            }
            break;
        }
        case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad:
        case 0xae: case 0xaf:
        {
            /* The string instructions, one instruction whatever the count, as ir.js runs
             * them; a fault partway leaves what the iterations before it did. */
            u32 size = (op & 1) ? opsize : 1, s = SIZE_INDEX(size), kind = op & 0xfe;
            if (hasSeg || lock) LEAVE(W_UNSUPPORTED);
            FOLD();
            u32 step = (fl & DF) ? (u32)-(i32)size : size, down = step != size;
            u32 repeat = rep != 0;
            u32 bulk = repeat && (kind == 0xa4 || kind == 0xaa);
            u32 passing = repeat && (kind == 0xa6 || kind == 0xae);
            for (;;)
            {
                if (repeat && regs[1] == 0) break;
                if (bulk && repeatBulk(kind, size, down) != 0) continue;
                if (passing) passBulk(kind, size, down, rep == 2);
                u32 done = 0;
                if (kind == 0xa4)
                {
                    u32 from = regs[6], to = regs[7];
                    READ_CHECK(from, size);
                    WRITE_CHECK(to, size);
                    store(to, size, load(from, size));
                    regs[6] = from + step;
                    regs[7] = to + step;
                }
                else if (kind == 0xaa)
                {
                    u32 to = regs[7];
                    WRITE_CHECK(to, size);
                    store(to, size, regOf(0, size));
                    regs[7] = to + step;
                }
                else if (kind == 0xac)
                {
                    u32 from = regs[6];
                    READ_CHECK(from, size);
                    setRegOf(0, size, load(from, size));
                    regs[6] = from + step;
                }
                else
                {
                    u32 a, b;
                    if (kind == 0xa6)
                    {
                        READ_CHECK(regs[6], size);
                        READ_CHECK(regs[7], size);
                        a = load(regs[6], size);
                        b = load(regs[7], size);
                        regs[6] += step;
                    }
                    else
                    {
                        READ_CHECK(regs[7], size);
                        a = regOf(0, size);
                        b = load(regs[7], size);
                    }
                    regs[7] += step;
                    u32 r = (a - b) & MASKS[s];
                    RECORD(L_SUB, s, r, a, b, 0);
                    FOLD();
                    done = repeat && ((fl & ZF) != 0) != (rep == 1);
                }
                /* A store into translated code ends the instruction here: the host
                 * invalidates, and a repeat goes on from the registers as they stand. */
                if (!repeat) break;
                regs[1] -= 1;
                if (done) break;
                if (codeWrite != NONE)
                {
                    if (regs[1] != 0)
                    {
                        exitValue = codeWrite;
                        exitSize = codeWriteSize;
                        code = W_CODE_WRITE;
                        eip = start;
                        goto done;
                    }
                    break;
                }
            }
            break;
        }
        case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
            setReg8(op & 7, p[len]);
            len += 1;
            break;
        case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        {
            u32 v;
            IMM(opsize, v);
            setRegOf(op & 7, opsize, v);
            break;
        }
        case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3:
        {
            u32 size = (op & 1) ? opsize : 1, a, count;
            MODRM();
            if (lock && isReg) LEAVE(W_UNSUPPORTED);
            if (op < 0xc2) { count = p[len]; len += 1; }
            else if (op < 0xd2) count = 1;
            else count = regs[1] & 0xff;
            RM_READ(size, a);
            count &= 31;
            if (count == 0) break;
            u32 s = SIZE_INDEX(size), bits = size * 8, m = MASKS[s], sg = SIGNS[s];
            u32 r, carry, over, written = ARITH;
            FOLD();
            switch (greg)
            {
            case 4: case 6:
                r = count < bits ? (a << count) & m : 0;
                carry = count <= bits ? (a >> (bits - count)) & 1 : 0;
                over = ((r & sg) ? 1 : 0) ^ carry;
                break;
            case 5:
                r = count < bits ? (a >> count) & m : 0;
                carry = count <= bits ? (a >> (count - 1)) & 1 : 0;
                over = (a & sg) ? 1 : 0;
                break;
            case 7:
            {
                i32 v = (i32)(a << (32 - bits)) >> (32 - bits);
                r = (u32)(count < bits ? v >> count : v >> (bits - 1)) & m;
                carry = count <= bits ? (u32)(v >> (count - 1)) & 1 : (u32)(v >> (bits - 1)) & 1;
                over = 0;
                break;
            }
            case 0:
            {
                u32 c = count % bits;
                r = c == 0 ? a : ((a << c) | (a >> (bits - c))) & m;
                carry = r & 1;
                over = ((r & sg) ? 1 : 0) ^ carry;
                written = CF | OF;
                break;
            }
            case 1:
            {
                u32 c = count % bits;
                r = c == 0 ? a : ((a >> c) | (a << (bits - c))) & m;
                carry = (r & sg) ? 1 : 0;
                over = carry ^ ((r & (sg >> 1)) ? 1 : 0);
                written = CF | OF;
                break;
            }
            case 2:
            {
                u32 c = count % (bits + 1), cin = fl & CF;
                r = a;
                for (u32 i = 0; i < c; i++)
                {
                    u32 top = (r & sg) ? 1 : 0;
                    r = ((r << 1) | cin) & m;
                    cin = top;
                }
                carry = cin;
                over = ((r & sg) ? 1 : 0) ^ carry;
                written = CF | OF;
                break;
            }
            default:
            {
                u32 c = count % (bits + 1), cin = fl & CF;
                over = ((a & sg) ? 1 : 0) ^ cin;
                r = a;
                for (u32 i = 0; i < c; i++)
                {
                    u32 low = r & 1;
                    r = ((r >> 1) | (cin << (bits - 1))) & m;
                    cin = low;
                }
                carry = cin;
                written = CF | OF;
                break;
            }
            }
            RM_WRITE(size, r);
            u32 f = (carry ? CF : 0) | (over ? OF : 0);
            if (written == ARITH) f |= resultFlags(r, s);
            fl = (fl & ~written) | f;
            break;
        }
        case 0xc2: case 0xc3:
        {
            u32 at = regs[4], extra = 0;
            READ_CHECK(at, 4);
            target = *(u32 *)(ram + at);
            if (op == 0xc2) IMM(2, extra);
            regs[4] = at + 4 + extra;
            jumped = 1;
            break;
        }
        case 0xc6: case 0xc7:
        {
            u32 size = (op & 1) ? opsize : 1, v;
            MODRM();
            if (greg != 0 || lock) LEAVE(W_UNSUPPORTED);
            IMM(size, v);
            RM_WRITE(size, v);
            break;
        }
        case 0xc9:
        {
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            u32 at = regs[5];
            READ_CHECK(at, 4);
            u32 v = *(u32 *)(ram + at);
            regs[4] = at + 4;
            regs[5] = v;
            break;
        }
        case 0xe0: case 0xe1: case 0xe2: case 0xe3:
        {
            u32 rel = (u32)(i32)(i8)p[len], h;
            len += 1;
            if (op == 0xe3) h = regs[1] == 0;
            else
            {
                regs[1] -= 1;
                if (regs[1] == 0 || op == 0xe2) h = regs[1] != 0;
                else
                {
                    FOLD();
                    h = ((fl & ZF) != 0) == (op == 0xe1);
                }
            }
            if (h) { target = eip + len + rel; jumped = 1; }
            break;
        }
        case 0xe6: case 0xe7: case 0xee: case 0xef:
        {
            /* out to the trap port: the host answers it after this instruction. */
            u32 port;
            if (op < 0xee) { port = p[len]; len += 1; }
            else port = regs[2] & 0xffff;
            if (port != trapPort) LEAVE(W_UNSUPPORTED);
            exitValue = (op & 1) ? regOf(0, opsize) : reg8(0);
            eip += len;
            n++;
            code = W_TRAP;
            goto done;
        }
        case 0xe8: case 0xe9: case 0xeb:
        {
            u32 rel;
            if (opsize != 4) LEAVE(W_UNSUPPORTED);
            if (op == 0xeb) { rel = (u32)(i32)(i8)p[len]; len += 1; }
            else IMM(4, rel);
            target = eip + len + rel;
            if (op == 0xe8) PUSH(eip + len);
            jumped = 1;
            break;
        }
        case 0xf4:
            eip += len;
            n++;
            code = W_HALT;
            goto done;
        case 0xf5: FOLD(); fl ^= CF; break;
        case 0xf8: FOLD(); fl &= ~CF; break;
        case 0xf9: FOLD(); fl |= CF; break;
        case 0xfc: fl &= ~DF; break;
        case 0xfd: fl |= DF; break;
        case 0xf6: case 0xf7:
        {
            u32 size = (op & 1) ? opsize : 1, s = SIZE_INDEX(size), m = MASKS[s], a;
            MODRM();
            if (lock && isReg) LEAVE(W_UNSUPPORTED);
            if (greg <= 1)
            {
                u32 b;
                IMM(size, b);
                RM_READ(size, a);
                RECORD(L_LOGIC, s, a & b, a, b, 0);
                break;
            }
            RM_READ(size, a);
            switch (greg)
            {
            case 2:
                RM_WRITE(size, ~a & m);
                break;
            case 3:
            {
                u32 r = (0 - a) & m;
                RM_WRITE(size, r);
                RECORD(L_SUB, s, r, 0, a, 0);
                break;
            }
            case 4:
            {
                u32 high;
                FOLD();
                if (size == 4)
                {
                    u64 product = (u64)regs[0] * a;
                    regs[0] = (u32)product;
                    regs[2] = high = (u32)(product >> 32);
                }
                else if (size == 2)
                {
                    u32 product = reg16(0) * a;
                    setReg16(0, product);
                    setReg16(2, high = product >> 16);
                }
                else
                {
                    u32 product = reg8(0) * a;
                    setReg16(0, product);
                    high = product >> 8;
                }
                fl = (fl & ~(CF | OF)) | (high ? CF | OF : 0);
                break;
            }
            case 5:
            {
                u32 fits;
                FOLD();
                if (size == 4)
                {
                    i64 product = (i64)(i32)regs[0] * (i32)a;
                    regs[0] = (u32)product;
                    regs[2] = (u32)((u64)product >> 32);
                    fits = product == (i64)(i32)product;
                }
                else if (size == 2)
                {
                    i32 product = (i16)reg16(0) * (i16)a;
                    setReg16(0, (u32)product);
                    setReg16(2, (u32)product >> 16);
                    fits = product == (i16)product;
                }
                else
                {
                    i32 product = (i8)reg8(0) * (i8)a;
                    setReg16(0, (u32)product);
                    fits = product == (i8)product;
                }
                fl = (fl & ~(CF | OF)) | (fits ? 0 : CF | OF);
                break;
            }
            case 6:
                if (a == 0) FAULT(0);
                if (size == 4)
                {
                    u64 dividend = (u64)regs[2] << 32 | regs[0], q = dividend / a;
                    if (q > 0xffffffffull) FAULT(0);
                    regs[0] = (u32)q;
                    regs[2] = (u32)(dividend % a);
                }
                else if (size == 2)
                {
                    u32 dividend = reg16(2) << 16 | reg16(0), q = dividend / a;
                    if (q > 0xffff) FAULT(0);
                    setReg16(0, q);
                    setReg16(2, dividend % a);
                }
                else
                {
                    u32 dividend = reg16(0), q = dividend / a;
                    if (q > 0xff) FAULT(0);
                    setReg16(0, (dividend % a) << 8 | q);
                }
                break;
            default:
                if (a == 0) FAULT(0);
                if (size == 4)
                {
                    i64 dividend = (i64)((u64)regs[2] << 32 | regs[0]), divisor = (i32)a;
                    if (dividend == (i64)0x8000000000000000ull && divisor == -1) FAULT(0);
                    i64 q = dividend / divisor;
                    if (q != (i64)(i32)q) FAULT(0);
                    regs[0] = (u32)q;
                    regs[2] = (u32)(dividend % divisor);
                }
                else if (size == 2)
                {
                    i32 dividend = (i32)(reg16(2) << 16 | reg16(0)), divisor = (i16)a;
                    if (dividend == (i32)0x80000000 && divisor == -1) FAULT(0);
                    i32 q = dividend / divisor;
                    if (q != (i16)q) FAULT(0);
                    setReg16(0, (u32)q);
                    setReg16(2, (u32)(dividend % divisor));
                }
                else
                {
                    i32 dividend = (i16)reg16(0), divisor = (i8)a, q = dividend / divisor;
                    if (q != (i8)q) FAULT(0);
                    setReg16(0, ((u32)(dividend % divisor) & 0xff) << 8 | ((u32)q & 0xff));
                }
                break;
            }
            break;
        }
        case 0xfe: case 0xff:
        {
            u32 size = (op & 1) ? opsize : 1, a;
            MODRM();
            if (lock && isReg) LEAVE(W_UNSUPPORTED);
            if (greg <= 1)
            {
                RM_READ(size, a);
                u32 s = SIZE_INDEX(size), v = (greg == 0 ? a + 1 : a - 1) & MASKS[s];
                FOLD();
                RM_WRITE(size, v);
                RECORD(greg == 0 ? L_INC : L_DEC, s, v, a, 1, 0);
                break;
            }
            if (op == 0xfe || opsize != 4 || greg == 3 || greg == 5 || greg == 7) LEAVE(W_UNSUPPORTED);
            RM_READ(4, a);
            if (greg == 6)
            {
                PUSH(a);
                break;
            }
            if (greg == 2) PUSH(eip + len);
            target = a;
            jumped = 1;
            break;
        }
        case 0x0f:
        {
            u32 op2 = p[len++];
            /* A mandatory prefix makes most of this map another instruction: SSE's or
             * none the tier has. The SSE helper is reached only where the integer
             * cases leave -- a check ahead of them made the integer paths five to ten
             * per cent slower -- and leaves what is not SSE. */
            if (rep) goto simd;
            if (op2 >= 0x80 && op2 <= 0x8f)
            {
                if (opsize != 4) LEAVE(W_UNSUPPORTED);
                IMM(4, rel);
                cc = op2 & 15;
                goto jcc;
            }
            if (op2 >= 0x90 && op2 <= 0x9f)
            {
                MODRM();
                if (lock && isReg) LEAVE(W_UNSUPPORTED);
                FOLD();
                RM_WRITE(1, holds(op2 & 15, fl));
                break;
            }
            if (op2 >= 0x40 && op2 <= 0x4f)
            {
                u32 v;
                MODRM();
                if (lock) LEAVE(W_UNSUPPORTED);
                /* The source is read even when nothing moves. */
                RM_READ(opsize, v);
                FOLD();
                if (holds(op2 & 15, fl)) setRegOf(greg, opsize, v);
                break;
            }
            switch (op2)
            {
            case 0x1f:
                MODRM();
                break;
            case 0xaf:
                MODRM();
                fa = regOf(greg, opsize);
                RM_READ(opsize, fb);
                goto multiply;
            case 0xb6: case 0xb7: case 0xbe: case 0xbf:
            {
                u32 from = (op2 & 1) ? 2 : 1, v;
                MODRM();
                if (lock) LEAVE(W_UNSUPPORTED);
                RM_READ(from, v);
                if (op2 >= 0xbe) v = from == 1 ? (u32)(i32)(i8)v : (u32)(i32)(i16)v;
                setRegOf(greg, opsize, v);
                break;
            }
            case 0xa3: case 0xab: case 0xb3: case 0xbb: case 0xba:
            {
                /* bt bts btr btc: a register offset reaches beyond a memory operand, a
                 * signed number of operands away; an immediate one wraps in it. */
                u32 bits = opsize * 8, offset, kind, a;
                MODRM();
                if (lock && isReg) LEAVE(W_UNSUPPORTED);
                if (op2 == 0xba)
                {
                    if (greg < 4) LEAVE(W_UNSUPPORTED);
                    kind = greg & 3;
                    offset = p[len] & (bits - 1);
                    len += 1;
                }
                else
                {
                    kind = (op2 >> 3) & 3;
                    offset = regOf(greg, opsize);
                    if (!isReg)
                    {
                        i32 signedOffset = (i32)(offset << (32 - bits)) >> (32 - bits);
                        i32 wordIndex = signedOffset >= 0 ? signedOffset / (i32)bits
                            : -((-signedOffset + (i32)bits - 1) / (i32)bits);
                        ea += (u32)(wordIndex * (i32)opsize);
                        offset = (u32)(signedOffset - wordIndex * (i32)bits);
                    }
                    else offset &= bits - 1;
                }
                RM_READ(opsize, a);
                u32 bit = (a >> offset) & 1;
                if (kind == 1) RM_WRITE(opsize, a | (1u << offset));
                else if (kind == 2) RM_WRITE(opsize, a & ~(1u << offset));
                else if (kind == 3) RM_WRITE(opsize, a ^ (1u << offset));
                FOLD();
                fl = (fl & ~CF) | bit;
                break;
            }
            case 0xbc: case 0xbd:
            {
                u32 v;
                MODRM();
                if (lock) LEAVE(W_UNSUPPORTED);
                RM_READ(opsize, v);
                FOLD();
                if (v == 0)
                {
                    fl |= ZF;
                    break;
                }
                setRegOf(greg, opsize, op2 == 0xbc ? (u32)__builtin_ctz(v) : 31 - (u32)__builtin_clz(v));
                fl &= ~ZF;
                break;
            }
            case 0xa4: case 0xa5: case 0xac: case 0xad:
            {
                u32 bits = opsize * 8, m = MASKS[si], a, b, count, r, carry;
                MODRM();
                if (lock && isReg) LEAVE(W_UNSUPPORTED);
                if ((op2 & 1) == 0) { count = p[len]; len += 1; }
                else count = regs[1] & 0xff;
                count &= 31;
                RM_READ(opsize, a);
                b = regOf(greg, opsize);
                if (count == 0) break;
                if (op2 < 0xac)
                {
                    r = count < bits ? ((a << count) | (b >> (bits - count))) & m : (b << (count - bits)) & m;
                    carry = count <= bits ? (a >> (bits - count)) & 1 : (b >> (2 * bits - count)) & 1;
                }
                else
                {
                    r = count < bits ? ((a >> count) | (b << (bits - count))) & m : (b >> (count - bits)) & m;
                    carry = count <= bits ? (a >> (count - 1)) & 1 : (b >> (count - bits - 1)) & 1;
                }
                RM_WRITE(opsize, r);
                FOLD();
                fl = (fl & ~ARITH) | (carry ? CF : 0) | (((a ^ r) & SIGNS[si]) ? OF : 0) | resultFlags(r, si);
                break;
            }
            case 0xb0: case 0xb1:
            {
                u32 size = (op2 & 1) ? opsize : 1, s = SIZE_INDEX(size), m = MASKS[s], d;
                MODRM();
                if (lock && isReg) LEAVE(W_UNSUPPORTED);
                RM_READ(size, d);
                u32 acc = regOf(0, size);
                if (acc == d) RM_WRITE(size, regOf(greg, size));
                else setRegOf(0, size, d);
                RECORD(L_SUB, s, (acc - d) & m, acc, d, 0);
                break;
            }
            case 0xc0: case 0xc1:
            {
                u32 size = (op2 & 1) ? opsize : 1, s = SIZE_INDEX(size), m = MASKS[s], a, b;
                MODRM();
                if (lock && isReg) LEAVE(W_UNSUPPORTED);
                RM_READ(size, a);
                b = regOf(greg, size);
                u32 r = (a + b) & m;
                /* The register takes the old value first, then the sum lands: xadd of a
                 * register with itself leaves the sum. */
                if (isReg) { setRegOf(greg, size, a); setRegOf(ea, size, r); }
                else { WRITE_CHECK(ea, size); setRegOf(greg, size, a); store(ea, size, r); }
                RECORD(L_ADD, s, r, a, b, 0);
                break;
            }
            case 0xc8: case 0xc9: case 0xca: case 0xcb: case 0xcc: case 0xcd: case 0xce: case 0xcf:
            {
                if (opsize != 4) LEAVE(W_UNSUPPORTED);
                u32 v = regs[op2 & 7];
                regs[op2 & 7] = (v >> 24) | ((v >> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24);
                break;
            }
            default:
            simd:
                helper = sse(p);
                goto helped;
            }
            break;
        }
        default:
            LEAVE(W_UNSUPPORTED);
        helped:
            /* What an x87 or SSE helper answered, and the instruction's length. */
            if (helper == X_LEAVE) LEAVE(W_UNSUPPORTED);
            if (helper == X_FAULT) FAULT(13);
            len = xLen;
            if (helper == X_FLAGS)
            {
                lk = 0;
                fl = (fl & ~ARITH) | xFlags;
            }
            if (xWrite != NONE)
            {
                codeWrite = xWrite;
                codeWriteSize = xWriteSize;
            }
            break;
        }
        n++;
        if (jumped)
        {
            eip = target;
            /* The ring of recent starts the host reports a stuck thread with; the park
             * loop is where a thread waits, not a path. */
            if (target - parkBase > 2)
            {
                starts[*startAt & 255] = target;
                *startAt += 1;
            }
            /* A jump's target is counted, and noted at the threshold and each power of
             * two after it; one with translated code is the host's to enter. */
            u8 *count = hotCounts + ((target >> 2) & hotMask);
            u32 c = *count;
            if (c < 255) *count = (u8)++c;
            if (c >= hotThreshold && (c & (c - 1)) == 0)
            {
                exitValue = c;
                code = W_HOT;
                goto done;
            }
            u32 slot = (target * 0x9e3779b1u) >> hashShift;
            for (;;)
            {
                u32 key = *(u32 *)(hash + slot * 12);
                /* An empty slot's key is 0: a jump to address 0 (a call through a null
                 * pointer) meets one and has no entry. */
                if (key == 0) break;
                if (key == target)
                {
                    code = W_ENTRY;
                    goto done;
                }
                slot = (slot + 1) & ((1u << (32 - hashShift)) - 1);
            }
        }
        else
        {
            eip += len;
        }
        if (codeWrite != NONE)
        {
            exitValue = codeWrite;
            exitSize = codeWriteSize;
            code = W_CODE_WRITE;
            goto done;
        }
        continue;
    out:
        /* Left, or faulted before its effect: eip at the instruction. */
        eip = start;
        goto done;
    }
done:
    FOLD();
    *eipField = eip;
    *eflagsField = fl;
    retired = n;
    return code;
}
#endif

/*
 * The instruction at eip, an fcmov runInteger left for its flags, run with the
 * flags word it folded into the block.
 */
static u32 foldedStep(void)
{
#ifdef LONG
    u64 rip = *ripField;
    xFlagsExact = 1;
    u32 x = x87(ram + (u32)rip);
    xFlagsExact = 0;
    if (x == X_DONE) *ripField = rip + xLen;
#else
    u32 eip = *eipField;
    xFlagsExact = 1;
    u32 x = x87(ram + eip);
    xFlagsExact = 0;
    if (x == X_DONE) *eipField = eip + xLen;
#endif
    return x;
}

__attribute__((export_name("run")))
u32 run(u32 budget)
{
    xNeedsFlags = 0;
    exactIn();
    u32 code = runInteger(budget), n = retired;
    while (code == W_UNSUPPORTED && xNeedsFlags)
    {
        xNeedsFlags = 0;
        if (n >= budget)
        {
            code = W_BUDGET;
            break;
        }
        u32 x = foldedStep();
        if (x != X_DONE)
        {
            code = x == X_FAULT ? W_FAULT : W_UNSUPPORTED;
            exitValue = 13;
            break;
        }
        n++;
        code = runInteger(budget - n);
        n += retired;
    }
    retired = n;
    exactOut();
    return code;
}

/*
 * The run translated code makes where an untranslated exit's target has no
 * region (the module's transfer function, on a miss of the entry hash), rather
 * than leave for the host: the state block holds the state, the flag record
 * folded. The target is a jump's, counted as the host counts one it is sent to,
 * a hot one leaving at once for the host to note; what the run retires is added
 * to the counter word, as the host adds a run's, and answered above the exit
 * code, for the caller to charge its budget with and go on at an entry itself.
 */
__attribute__((export_name("enter")))
u32 enter(u32 budget)
{
#ifdef LONG
    /* A start past the window is the host's to fault. */
    if ((*ripField >> 32) != 0)
    {
        retired = 0;
        return 0;
    }
    u32 at = (u32)*ripField;
#else
    u32 at = *eipField;
#endif
    /* A block closed in a translated loop has no entry until the runtime forms the
     * region's copies, which it does once translated code has left for it often
     * enough: a miss there is the host's to count, answered as no tier. */
    if (pageFlags[at >> 12] & CLOSED)
    {
        retired = 0;
        return 0;
    }
    u8 *count = hotCounts + ((at >> 2) & hotMask);
    u32 c = *count;
    if (c < 255) *count = (u8)++c;
    if (c >= hotThreshold && (c & (c - 1)) == 0)
    {
        exitValue = c;
        retired = 0;
        return W_HOT;
    }
    /* What it retired must fit above the code's byte. */
    u32 code = run(budget < 0xffffff ? budget : 0xffffff);
    *counterAt += retired;
    *enteredAt += retired;
    return code | retired << 8;
}
