#!/bin/sh
# Builds the x86-64 twins of build.sh's workload images into images64/: the same sources compiled
# for long mode (SysV's calling convention, SSE2 floats as an x64 compiler's), each a flat image
# loaded at 0x401000 like the 32-bit ones, so `bench.mjs --bits 64` runs every workload the
# 32-bit translator runs on the 64-bit one. The x87 builds have no twin (an x64 compiler emits
# SSE); a float workload's twin is named after its SSE build. lua-x64 is Lua 5.1.5 as lua-x87,
# its libc's floor, ceil, fabs and sqrt SSE2 as an x64 runtime's. Needs gcc, GNU binutils and,
# for Lua's source, curl; the images are committed, so a run needs none of them.
set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
mkdir -p images64
COMMON="-m64 -O2 -fno-pic -fno-pie -fno-stack-protector -ffreestanding -fno-builtin -nostdlib
    -fno-asynchronous-unwind-tables -fcf-protection=none -mno-red-zone"
as --64 src/rt64.S -o "$OUT/rt.o"
node src/load.mjs > "$OUT/load.c"
CALLS="calls8-order calls8-scatter calls512-order calls512-scatter calls4096-order calls4096-scatter"
for w in $CALLS; do
    N=${w#calls}; node src/calls.mjs "${N%-*}" "${w#*-}" > "$OUT/$w.c"
done
build(){ # workload name
    SOURCE="src/$1.c"
    [ -f "$SOURCE" ] || SOURCE="$OUT/$1.c"
    gcc $COMMON -c "$SOURCE" -o "$OUT/$1.o"
    gcc $COMMON -c src/lib.c -o "$OUT/lib.o"
    ld -m elf_x86_64 -T link.ld "$OUT/rt.o" "$OUT/$1.o" "$OUT/lib.o" -o "$OUT/$1.elf"
    objcopy -O binary "$OUT/$1.elf" "images64/$2.bin"
    echo "images64/$2.bin: $(wc -c < "images64/$2.bin") bytes"
}
for w in vm tree vcall sort str crc switch load patch $CALLS; do build $w "$w-x64"; done
for w in fmath game; do build $w "$w-x64"; done

LUA=lua-5.1.5
curl -fsSL "https://www.lua.org/ftp/$LUA.tar.gz" -o "$OUT/lua.tgz"
echo "2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333  $OUT/lua.tgz" | sha256sum -c - > /dev/null
tar xzf "$OUT/lua.tgz" -C "$OUT"
LUACF="$COMMON -nostdinc -isystem src/lua/include -isystem $(gcc -print-file-name=include)"
LUAOBJ=""
for f in lapi lcode ldebug ldo ldump lfunc lgc llex lmem lobject lopcodes lparser lstate lstring \
         ltable ltm lundump lvm lzio lauxlib lbaselib lstrlib ltablib lmathlib; do
    gcc $LUACF -c "$OUT/$LUA/src/$f.c" -o "$OUT/lua-$f.o"
    LUAOBJ="$LUAOBJ $OUT/lua-$f.o"
done
gcc $LUACF -c src/lua/libc.c -o "$OUT/lua-libc.o"
gcc $LUACF -I"$OUT/$LUA/src" -c src/lua/client.c -o "$OUT/lua-client.o"
node -e '
const s = require("fs").readFileSync(process.argv[1]);
process.stdout.write(`const unsigned char addons_lua[] = {${[...s].join(",")},0};\n`
    + `const unsigned addons_lua_len = ${s.length};\n`);
' src/lua/addons.lua > "$OUT/lua-script.c"
gcc $LUACF -c "$OUT/lua-script.c" -o "$OUT/lua-script.o"
as --64 src/lua/setjmp64.S -o "$OUT/lua-setjmp.o"
ld -m elf_x86_64 -T link.ld "$OUT/rt.o" $LUAOBJ "$OUT/lua-libc.o" "$OUT/lua-client.o" \
    "$OUT/lua-script.o" "$OUT/lua-setjmp.o" -o "$OUT/lua-x64.elf"
objcopy -O binary "$OUT/lua-x64.elf" images64/lua-x64.bin
echo "images64/lua-x64.bin: $(wc -c < images64/lua-x64.bin) bytes"
rm -r "$OUT"
