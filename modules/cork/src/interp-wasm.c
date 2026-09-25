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
 * What it does not model -- x87, MMX, SSE, the system and rare forms, a fetch
 * from a page it cannot read -- it leaves unexecuted with eip at the
 * instruction, answering W_UNSUPPORTED, and the JavaScript interpreter runs it.
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

__attribute__((export_name("retired"))) u32 getRetired(void) { return retired; }
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

__attribute__((export_name("run")))
u32 run(u32 budget)
{
    u32 eip = *eipField;
    u32 fl = *eflagsField;
    /* The last flag writer: while lk is not zero the arithmetic bits of fl are stale
     * (all but CF after inc/dec, which keeps it). */
    u32 lk = 0, lr = 0, la = 0, lb = 0, lc = 0;
    u32 n = 0;
    u32 code;
    u32 start;

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

        u32 target = 0, jumped = 0;
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
            /* A mandatory prefix makes most of this map another instruction. */
            if (rep) LEAVE(W_UNSUPPORTED);
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
                LEAVE(W_UNSUPPORTED);
            }
            break;
        }
        default:
            LEAVE(W_UNSUPPORTED);
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
