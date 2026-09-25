#!/bin/sh
# Builds the workload images from src/: each a flat i386 image loaded at 0x401000, the x87
# build (the era's compilers' default) of every workload and an SSE one of the float ones.
# Needs gcc with -m32 and GNU binutils; the images are committed, so a run needs neither.
set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
COMMON="-m32 -O2 -fno-pic -fno-pie -fno-stack-protector -ffreestanding -fno-builtin -nostdlib
    -fno-asynchronous-unwind-tables -fcf-protection=none"
X87="-march=pentium3 -mfpmath=387 -mno-sse"
SSE="-march=pentium4 -mfpmath=sse -msse2"
as --32 src/rt.S -o "$OUT/rt.o"
node src/load.mjs > "$OUT/load.c"
build(){ # workload variant flags
    SOURCE="src/$1.c"
    [ -f "$SOURCE" ] || SOURCE="$OUT/$1.c"
    gcc $COMMON $3 -c "$SOURCE" -o "$OUT/$1-$2.o"
    gcc $COMMON $3 -c src/lib.c -o "$OUT/lib-$2.o"
    ld -m elf_i386 -T link.ld "$OUT/rt.o" "$OUT/$1-$2.o" "$OUT/lib-$2.o" -o "$OUT/$1-$2.elf"
    objcopy -O binary "$OUT/$1-$2.elf" "images/$1-$2.bin"
    echo "images/$1-$2.bin: $(wc -c < "images/$1-$2.bin") bytes"
}
for w in vm tree vcall sort str crc switch load; do build $w x87 "$X87"; done
for w in fmath game; do build $w x87 "$X87"; build $w sse "$SSE"; done
rm -r "$OUT"
