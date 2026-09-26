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
#define NONE 0xffffffffu

static u8 *ram;
static u8 *pageFlags;
static u8 *codeRanges;
static u32 *regs;
static u32 *eipField;
static u32 *eflagsField;
static u32 *fsBaseField;
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
/* The XMM registers, four words each, and MXCSR, in the block. */
static u32 *xmmRegs;
static u32 *mxcsrAt;
/* The engine's `precise`: unless it is set, the x87 bookkeeping games do not
 * read is not kept (see the float section). */
static u32 precise;
/* Status-word stores (fnstsw) run while not precise: what a relaxed bit could reach. */
static u32 relaxedReads;

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
    regs = (u32 *)regsAt;
    eipField = (u32 *)eipAt;
    eflagsField = (u32 *)eflagsAt;
    fsBaseField = (u32 *)fsBaseAt;
    hotCounts = (u8 *)area;
    hotMask = hotSlots - 1;
    hotThreshold = threshold;
    starts = (u32 *)(area + hotSlots);
    startAt = starts + 256;
    trapPort = port;
    parkBase = park;
}

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

static const u8 PARITY[256] = {
#define P2(n) n, n ^ 1, n ^ 1, n
#define P4(n) P2(n), P2(n ^ 1), P2(n ^ 1), P2(n)
#define P6(n) P4(n), P4(n ^ 1), P4(n ^ 1), P4(n)
    P6(1), P6(0), P6(0), P6(1)
};
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

static inline u32 resultFlags(u32 r, u32 si)
{
    return (r == 0 ? ZF : 0) | ((r & SIGNS[si]) ? SF : 0) | (PARITY[r & 0xff] ? PF : 0);
}

/* The lazy record's kinds; the record's kind word is kind << 2 | size index. */
enum { L_ADD = 1, L_ADC, L_SUB, L_SBB, L_LOGIC, L_INC, L_DEC };

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
 * host's `Math`, and the partial remainder the model's own, imported as
 * translated code imports them, so the three agree. A quadword fild's
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
IMPORT("fprem") double hostFprem(double, double, u32);
IMPORT("fpremStatus") u32 hostFpremStatus(double, double, u32);

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
    if (diff < 0.5) return low;
    if (diff > 0.5) return low + 1;
    return __builtin_floor(low * 0.5) * 2 == low ? low : low + 1;
}

/* The ten-byte extended value as a double; a NaN loses its payload and a zero
 * its sign, as the model's conversion does. */
static double f80ToF64(u64 low, u32 high)
{
    if ((high & 0x7fff) == 0x7fff)
    {
        u64 special = (low & ~SIGN64) == 0 ? 0x7ff0000000000000ull : HOST_NAN_BITS;
        return fromBits(special | (u64)(high & 0x8000) << 48);
    }
    if (low == 0) return 0;
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
 * the integers. Dropped at every run's start, as the JavaScript interpreter drops
 * its own at every sync: another tier may have written the registers between. */
static u32 exactMarks;
static i64 exactShadow[8];

/* The stack-fault check: t1 when a source ST(i) -- a bit per i in `sources` --
 * is empty or a push finds its register held, raising IE and SF; a push sets
 * C1 when it overflowed and clears it when not. */
static inline u32 guard(u32 top, u32 empty, u32 *status, u32 sources, u32 pushes)
{
    u32 read = ((sources << top) | (sources >> (8 - top))) & 0xff;
    u32 t1 = (empty & read) != 0;
    if (pushes)
    {
        u32 held = ((empty >> ((top - 1) & 7)) & 1) == 0;
        t1 |= held;
        if (held) *status |= S_C1;
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
    if (isNaN(r) && !isNaN(a0) && !isNaN(c0)) *status |= S_IE;
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
/* A push writes the register it lands in, a pop drops the one it frees: the
 * registers an exact integer no longer holds (xw, xp). */
#define PUSH_ST(v) do { double _v = (v); top = (top - 1) & 7; xw |= 1u << top; REG(top) = _v; \
        empty &= ~(1u << top); } while (0)
#define POP_ST() do { xp |= 1u << top; empty |= 1u << top; top = (top + 1) & 7; } while (0)
#define X_READ(a, size) do { if (touches((a), (size), INACCESSIBLE)) { code = X_FAULT; goto done; } } while (0)
#define X_WRITE(a, size) do { u32 _a = (a); \
        if (touches(_a, (size), INACCESSIBLE | HAS_CODE)) \
        { \
            if (touches(_a, (size), INACCESSIBLE)) { code = X_FAULT; goto done; } \
            if (codeHit(_a) || codeHit(_a + (size) - 1)) { xWrite = _a; xWriteSize = (size); } \
        } } while (0)

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

/* The whole length of the instruction a helper ran. */
static u32 xLen;

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
    u32 len, seg, key, lock, escape = prefixed(p, &len, &seg, &key, &lock);
    if (key >= 2 || lock) return X_LEAVE;
    u32 top = *x87TopAt & 7, empty = *x87EmptyAt, status = *x87StatusAt, control = *x87ControlAt;
    u32 modrm = p[len], ea = 0;
    if (modrm < 0xc0) ea = memoryOperand(p, &len, seg);
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
                ST(0) = arith(g, ST(0), c0, t1, control, &status);
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
                /* A signalling NaN: the quiet bit (62) clear, another fraction bit set. */
                if (precise && (high & 0x7fff) == 0x7fff && (low & 0x4000000000000000ull) == 0
                    && (low & 0x3fffffffffffffffull) != 0) status |= S_IE;
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
            /* fst, fstp m32fp, m64fp; fstp m80fp */
            double v = OR_INDEFINITE(ST(0), GUARD(1, 0));
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
            ST(0) = arith(g, ST(0), ST(i), t1, control, &status);
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
        ST(i) = arith(g >= 4 ? g ^ 1 : g, ST(i), ST(0), t1, control, &status);
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
        case 0xe0:
        {
            double v = -ST(0);
            ST(0) = OR_INDEFINITE(v, GUARD(1, 0));
            break;
        }
        case 0xe1:
        {
            double v = __builtin_fabs(ST(0));
            ST(0) = OR_INDEFINITE(v, GUARD(1, 0));
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
            ST(0) = OR_INDEFINITE(v, GUARD(1, 0));
            break;
        }
        case 0xf1: case 0xf9:
        {
            double r;
            t1 = GUARD(3, 0);
            if (modrm == 0xf1)
            {
                if (precise && ST(0) == 0 && __builtin_fabs(ST(1)) < __builtin_inf() && ST(1) != 0) status |= S_ZE;
                if (precise && ST(0) < 0) status |= S_IE;
                double log = quietNaN(hostLog2(ST(0)));
                r = twoNaN(ST(1) * log, ST(1), log);
            }
            else
            {
                if (precise && ST(0) < -1) status |= S_IE;
                double log = quietNaN(hostLog1p(ST(0))) / fromBits(0x3fe62e42fefa39efull);
                r = twoNaN(ST(1) * log, ST(1), log);
            }
            ST(1) = OR_INDEFINITE(r, t1);
            POP_ST();
            break;
        }
        case 0xf3:
        {
            double r = hostAtan2(ST(1), ST(0));
            ST(1) = OR_INDEFINITE(r, GUARD(3, 0));
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
                    ST(0) = hostSin(v);
                    PUSH_ST(hostCos(v));
                }
                else if (modrm == 0xf2)
                {
                    ST(0) = hostTan(v);
                    PUSH_ST(1);
                }
                else ST(0) = modrm == 0xfe ? hostSin(v) : hostCos(v);
            }
            else if (isNaN(v) || t1)
            {
                ST(0) = fromBits(INDEFINITE_BITS);
                if (pushes) PUSH_ST(fromBits(INDEFINITE_BITS));
            }
            else status |= S_C2;
            break;
        }
        case 0xf4:
        {
            t1 = GUARD(1, 1);
            double original = ST(0), v = original, exponent = 0, significand;
            if (v == 0)
            {
                if (precise) status |= S_ZE;
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
            if (isNaN(v) || __builtin_fabs(v) == __builtin_inf())
            {
                ST(0) = OR_INDEFINITE(original, t1);
                PUSH_ST(OR_INDEFINITE(original, t1));
                break;
            }
            ST(0) = OR_INDEFINITE(exponent, t1);
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
                if (precise) status |= S_IE;
                ST(0) = fromBits(INDEFINITE_BITS);
                break;
            }
            u32 nearest = modrm == 0xf5;
            status &= ~(S_C2 | S_C0 | S_C3 | S_C1);
            ST(0) = hostFprem(a, c, nearest);
            status |= hostFpremStatus(a, c, nearest);
            break;
        }
        case 0xf6:
            top = (top - 1) & 7;
            break;
        case 0xf7:
            top = (top + 1) & 7;
            break;
        case 0xfa:
        {
            t1 = GUARD(1, 0);
            double a = ST(0);
            if (precise && a < 0) status |= S_IE;
            ST(0) = OR_INDEFINITE(byPrecision(hostNaN(__builtin_sqrt(a), a, a), control), t1);
            break;
        }
        case 0xfc:
        {
            double v = roundBy(ST(0), control);
            ST(0) = OR_INDEFINITE(v, GUARD(1, 0));
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
            ST(0) = OR_INDEFINITE(v, t1);
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
            GUARD(1 | 1u << i, 0);
            if (holds(CONDITIONS[g & 3] + (e & 1), *eflagsField)) ST(0) = ST(i);
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
            regs[0] = (regs[0] & 0xffff0000u) | ((status & ~0x3800u) | top << 11);
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
    GUARD(1 | 1u << i, 0);
    double v = REG(top);
    REG(top) = ST(i);
    ST(i) = v;
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
    double v = OR_INDEFINITE(ST(0), t1);
    ST(i) = v;
    empty &= ~(1u << PHYS(i));
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
 * before anything lands. The MMX forms (an `mm` operand puts the x87 stack
 * in the MMX state) and maskmovdqu are left to the JavaScript tier.
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

/* The memory operand loaded as the model's readVector reads it: `width` bytes, the rest zero. */
#define LOAD_M(v, width) do { \
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
        X_WRITE(ea, (width)); \
        if ((width) == 16) { *(u64 *)(ram + ea) = (v).q[0]; *(u64 *)(ram + ea + 8) = (v).q[1]; } \
        else if ((width) == 8) *(u64 *)(ram + ea) = (v).q[0]; \
        else *(u32 *)(ram + ea) = (v).w[0]; \
    } while (0)

/*
 * One SSE instruction, at p (0F and the byte after it past the prefixes), taken
 * as x87 is. Nothing runs before a form is known to be modelled, so X_LEAVE
 * leaves the state as it was.
 */
__attribute__((noinline))
static u32 sse(const u8 *p)
{
    u32 len, seg, key, lock;
    prefixed(p, &len, &seg, &key, &lock);
    if (lock) return X_LEAVE;
    u32 op2 = p[len++], modrm = p[len], ea = 0, mem = modrm < 0xc0, reg = (modrm >> 3) & 7;
    u32 rm = modrm & 7;
    if (mem) ea = memoryOperand(p, &len, seg);
    else len += 1;
    xWrite = NONE;
    u32 code = X_DONE;
    V128 a, b;
    /* The immediate, for the forms that have one, after the addressing bytes. */
    u32 imm = p[len];
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
                double r = op2 == 0x51 ? __builtin_sqrt(x) : op2 == 0x52 ? 1 / __builtin_sqrt(x) : 1 / x;
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
                /* The operand chosen, as the model puts it back through a single. */
                double x = widen(a.w[i]), y = widen(b.w[i]);
                u32 pick = (op2 == 0x5d ? x < y : x > y) ? a.w[i] : b.w[i];
                a.w[i] = isNaN32(pick) ? pick | 0x400000u : pick;
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
        /* A fetch within one readable page, or across into a readable one. */
        if ((pageFlags[eip >> 12] & INACCESSIBLE)
            || ((eip & 0xfff) > 0xff0 && (pageFlags[(eip + 15) >> 12] & INACCESSIBLE)))
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
            if (touches(_a, (size), INACCESSIBLE | HAS_CODE)) \
            { \
                if (touches(_a, (size), INACCESSIBLE)) FAULT(13); \
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
            if (touches(at, 32, INACCESSIBLE | HAS_CODE)) LEAVE(W_UNSUPPORTED);
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
            if (lock && isReg) LEAVE(W_UNSUPPORTED);
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
            u32 v = *(u32 *)(ram + at), w = 0xcd5 | DF | (1u << 11) | (1u << 18) | (1u << 21);
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
            u32 step = (fl & DF) ? (u32)-(i32)size : size;
            u32 repeat = rep != 0;
            for (;;)
            {
                if (repeat && regs[1] == 0) break;
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
                if (key == target)
                {
                    code = W_ENTRY;
                    goto done;
                }
                if (key == 0) break;
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

/*
 * The instruction at eip, an fcmov runInteger left for its flags, run with the
 * flags word it folded into the block.
 */
static u32 foldedStep(void)
{
    u32 eip = *eipField;
    xFlagsExact = 1;
    u32 x = x87(ram + eip);
    xFlagsExact = 0;
    if (x == X_DONE) *eipField = eip + xLen;
    return x;
}

__attribute__((export_name("run")))
u32 run(u32 budget)
{
    xNeedsFlags = 0;
    exactMarks = 0;
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
    return code;
}
