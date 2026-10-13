#!/bin/sh
# Builds the workload images from src/: each a flat i386 image loaded at 0x401000, the x87
# build (the era's compilers' default) of every workload, an SSE one of the float ones, and
# the x87 float ones again under single precision control (pc24: rt-pc24.S sets it once
# before the first main, as creating a Direct3D device does on its thread), and the long-run
# workloads of churn.mjs into soak/, which bench.mjs and the emitter's digest do not read.
# lua-x87 is Lua 5.1.5, fetched by its checksum and built freestanding against the small C
# library in src/lua, running one frame of a raid's interface a call: client.c pushes the
# frame's events through Lua's C API to 27 addons (addons.lua) and answers their checksum.
# Needs gcc with -m32, GNU binutils and, for Lua's source, curl; the images are committed, so a
# run needs none of them.
set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
COMMON="-m32 -O2 -fno-pic -fno-pie -fno-stack-protector -ffreestanding -fno-builtin -nostdlib
    -fno-asynchronous-unwind-tables -fcf-protection=none"
X87="-march=pentium3 -mfpmath=387 -mno-sse"
SSE="-march=pentium4 -mfpmath=sse -msse2"
as --32 src/rt.S -o "$OUT/rt.o"
as --32 src/rt-pc24.S -o "$OUT/rt-pc24.o"
node src/load.mjs > "$OUT/load.c"
node src/world.mjs > "$OUT/world.c"
CALLS="calls8-order calls8-scatter calls512-order calls512-scatter calls4096-order calls4096-scatter"
for w in $CALLS; do
    N=${w#calls}; node src/calls.mjs "${N%-*}" "${w#*-}" > "$OUT/$w.c"
done
build(){ # workload variant flags [start] [directory]
    SOURCE="src/$1.c"
    [ -f "$SOURCE" ] || SOURCE="$OUT/$1.c"
    gcc $COMMON $3 -c "$SOURCE" -o "$OUT/$1-$2.o"
    gcc $COMMON $3 -c src/lib.c -o "$OUT/lib-$2.o"
    ld -m elf_i386 -T link.ld "$OUT/${4:-rt}.o" "$OUT/$1-$2.o" "$OUT/lib-$2.o" -o "$OUT/$1-$2.elf"
    objcopy -O binary "$OUT/$1-$2.elf" "${5:-images}/$1-$2.bin"
    echo "${5:-images}/$1-$2.bin: $(wc -c < "${5:-images}/$1-$2.bin") bytes"
}
for w in vm tree vcall sort str crc switch load patch $CALLS; do build $w x87 "$X87"; done
for w in fmath game; do build $w x87 "$X87"; build $w sse "$SSE"; build $w pc24 "$X87" rt-pc24; done
mkdir -p soak
build world x87 "$X87" rt soak

LUA=lua-5.1.5
curl -fsSL "https://www.lua.org/ftp/$LUA.tar.gz" -o "$OUT/lua.tgz"
echo "2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333  $OUT/lua.tgz" | sha256sum -c - > /dev/null
tar xzf "$OUT/lua.tgz" -C "$OUT"
LUACF="$COMMON $X87 -nostdinc -isystem src/lua/include -isystem $(gcc -print-file-name=include)"
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
as --32 src/lua/setjmp.S -o "$OUT/lua-setjmp.o"
ld -m elf_i386 -T link.ld "$OUT/rt.o" $LUAOBJ "$OUT/lua-libc.o" "$OUT/lua-client.o" "$OUT/lua-script.o" \
    "$OUT/lua-setjmp.o" -o "$OUT/lua-x87.elf"
objcopy -O binary "$OUT/lua-x87.elf" images/lua-x87.bin
echo "images/lua-x87.bin: $(wc -c < images/lua-x87.bin) bytes"
rm -r "$OUT"
