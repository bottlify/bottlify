#!/bin/sh
# Builds the workload images from src/: each a flat i386 image loaded at 0x401000, the x87
# build (the era's compilers' default) of every workload, an SSE one of the float ones, and
# the x87 float ones again under single precision control (pc24: rt-pc24.S sets it once
# before the first main, as creating a Direct3D device does on its thread).
# Needs gcc with -m32 and GNU binutils; the images are committed, so a run needs neither.
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
CALLS="calls8-order calls8-scatter calls512-order calls512-scatter calls4096-order calls4096-scatter"
for w in $CALLS; do
    N=${w#calls}; node src/calls.mjs "${N%-*}" "${w#*-}" > "$OUT/$w.c"
done
build(){ # workload variant flags [start]
    SOURCE="src/$1.c"
    [ -f "$SOURCE" ] || SOURCE="$OUT/$1.c"
    gcc $COMMON $3 -c "$SOURCE" -o "$OUT/$1-$2.o"
    gcc $COMMON $3 -c src/lib.c -o "$OUT/lib-$2.o"
    ld -m elf_i386 -T link.ld "$OUT/${4:-rt}.o" "$OUT/$1-$2.o" "$OUT/lib-$2.o" -o "$OUT/$1-$2.elf"
    objcopy -O binary "$OUT/$1-$2.elf" "images/$1-$2.bin"
    echo "images/$1-$2.bin: $(wc -c < "images/$1-$2.bin") bytes"
}
for w in vm tree vcall sort str crc switch load patch $CALLS; do build $w x87 "$X87"; done
for w in fmath game; do build $w x87 "$X87"; build $w sse "$SSE"; build $w pc24 "$X87" rt-pc24; done
rm -r "$OUT"
