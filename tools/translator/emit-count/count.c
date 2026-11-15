/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A QEMU TCG plugin for emit-count.mjs: counts the instructions every guest
 * thread executes, by what the code is - "js" (code V8 made at run time,
 * which has no symbol, and V8's builtins, `Builtins_*`), "compile" (V8's
 * optimising compilers, the deoptimiser and their zones), "gc" (the
 * collector) and "other" (the rest of node and its libraries). A block is
 * put by the symbol of its first instruction, so a compiler's call into a
 * common routine counts as "other": the split is by where the code is, not
 * by who called it. The running totals are printed at every fdatasync the
 * guest makes (the measured program's mark) and at exit.
 *
 *     gcc -shared -fPIC -O2 $(pkg-config --cflags glib-2.0) -I<qemu>/include/qemu count.c -o count.so
 */

#include <stdio.h>
#include <string.h>
#include <glib.h>
#include "qemu-plugin.h"

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

enum { JS, COMPILE, GC, OTHER, KINDS };
static uint64_t totals[KINDS];

/* Pieces of mangled C++ names (`_ZN2v88internal8compiler...`). */
static const char *const COMPILE_NAMES[] = { "8compiler", "6maglev", "10turboshaft", "Deoptimizer",
    "4Zone", "ZoneList", "OptimizedCompilationJob", "TurbofanCompilationJob", NULL };
static const char *const GC_NAMES[] = { "4Heap", "Scavenger", "MarkCompact", "Sweeper",
    "MarkingVisitor", "ConcurrentMarking", "MinorMark", "Evacuat", "Marking", "SemiSpace",
    "NewSpace", "PagedSpace", "MemoryAllocator", "LocalHeap", "WeakObjects", NULL };

static int any(const char *symbol, const char *const *names)
{
    for (int i = 0; names[i]; i++)
    {
        if (strstr(symbol, names[i]))
        {
            return 1;
        }
    }
    return 0;
}

static int kind_of(const char *symbol)
{
    if (!symbol || !*symbol || strncmp(symbol, "Builtins_", 9) == 0)
    {
        return JS;
    }
    if (any(symbol, COMPILE_NAMES))
    {
        return COMPILE;
    }
    return any(symbol, GC_NAMES) ? GC : OTHER;
}

/* The block's instruction count and kind in one pointer: count << 2 | kind. */
static void executed(unsigned int cpu, void *packed)
{
    uintptr_t value = (uintptr_t)packed;
    __atomic_fetch_add(&totals[value & 3], (uint64_t)(value >> 2), __ATOMIC_RELAXED);
}

static void translated(qemu_plugin_id_t id, struct qemu_plugin_tb *tb)
{
    size_t count = qemu_plugin_tb_n_insns(tb);
    int kind = kind_of(qemu_plugin_insn_symbol(qemu_plugin_tb_get_insn(tb, 0)));
    qemu_plugin_register_vcpu_tb_exec_cb(tb, executed, QEMU_PLUGIN_CB_NO_REGS,
        (void *)(uintptr_t)(count << 2 | kind));
}

static void say(const char *what)
{
    uint64_t now[KINDS];
    uint64_t all = 0;
    for (int i = 0; i < KINDS; i++)
    {
        now[i] = __atomic_load_n(&totals[i], __ATOMIC_RELAXED);
        all += now[i];
    }
    fprintf(stderr, "%s : %llu js %llu compile %llu gc %llu other %llu\n", what, (unsigned long long)all,
        (unsigned long long)now[JS], (unsigned long long)now[COMPILE], (unsigned long long)now[GC],
        (unsigned long long)now[OTHER]);
}

/* fdatasync (75 on x86-64): nothing in node calls it, so the measured program does to mark. */
static void on_syscall(qemu_plugin_id_t id, unsigned int cpu, int64_t number, uint64_t a1, uint64_t a2,
    uint64_t a3, uint64_t a4, uint64_t a5, uint64_t a6, uint64_t a7, uint64_t a8)
{
    if (number == 75)
    {
        say("Mark");
    }
}

static void exited(qemu_plugin_id_t id, void *data)
{
    say("Collected");
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id, const qemu_info_t *info, int argc,
    char **argv)
{
    qemu_plugin_register_vcpu_tb_trans_cb(id, translated);
    qemu_plugin_register_vcpu_syscall_cb(id, on_syscall);
    qemu_plugin_register_atexit_cb(id, exited, NULL);
    return 0;
}
