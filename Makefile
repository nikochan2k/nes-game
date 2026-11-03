# NES toolchain (cc65 + GNU Make)
#   make          build ROM + Mesen debug symbols (CHR は gfx/gen_chr.py から生成)
#   make run      open in Mesen if installed, else the default app
#   make server   run the map server (Raspberry Pi 側と同じもの)
#   make bridge   open in Mesen with the serial bridge script (要 make server)
#   make test     run the map server tests
#   make doctor   check recommended tools

CL65     ?= cl65
CA65     ?= ca65
LD65     ?= ld65
SRC      := src/crt0.s src/ppu.s src/main.c src/link.c src/worldgen.c src/chr.s
CFG      := cfg/field.cfg
CHR      := gfx/tiles.chr
ROM      := build/field.nes
DBG      := build/field.dbg

MESEN_APP := $(firstword $(wildcard \
	/Applications/Mesen.app \
	$(HOME)/Applications/Mesen.app \
	/Applications/Mesen*.app \
	$(HOME)/Applications/Mesen*.app \
))

FAMISTUDIO_APP := $(firstword $(wildcard \
	/Applications/FamiStudio.app \
	$(HOME)/Applications/FamiStudio.app \
))

.PHONY: all clean run bridge server test doctor

all: $(ROM)

$(CHR): gfx/gen_chr.py
	python3 gfx/gen_chr.py $@

$(ROM): $(SRC) $(wildcard src/*.h) $(CFG) $(CHR)
	@mkdir -p build
	$(CL65) -t none -O -g -C $(CFG) --obj-path build \
		-Wl --dbgfile,$(DBG) \
		-o $@ $(SRC)
	@echo "Built $@ ($(DBG))"

run: $(ROM)
ifeq ($(MESEN_APP),)
	open $(ROM)
else
	open -a "$(MESEN_APP)" $(ROM)
endif

# Mesen のスクリプトウィンドウで "Allow network access" を有効にしておくこと
bridge: $(ROM)
ifeq ($(MESEN_APP),)
	@echo "Mesen.app が見つからない"; exit 1
else
	"$(MESEN_APP)/Contents/MacOS/Mesen" $(ROM) mesen/bridge.lua
endif

server:
	python3 server/mapserver.py -v

test:
	cd server && python3 -m unittest -v

clean:
	rm -rf build
	rm -f src/*.o

doctor:
	@echo "== assembler / linker (cc65; NESASM は使わない) =="
	@command -v $(CL65) && $(CL65) --version || echo "MISSING: cl65  (brew install cc65)"
	@command -v $(CA65) || echo "MISSING: ca65"
	@command -v $(LD65) || echo "MISSING: ld65"
	@echo
	@echo "== build (Make) =="
	@make --version | head -1
	@echo
	@echo "== emulator (Mesen) =="
	@if [ -n "$(MESEN_APP)" ]; then echo "$(MESEN_APP)"; else \
		echo "MISSING: Mesen.app"; \
		echo "  Intel Mac: https://github.com/SourMesen/Mesen2/releases"; \
		echo "  先に SDL2 が必要 (この Mac には入っている)"; \
	fi
	@echo
	@echo "== graphics (YY-CHR / NEXXT は Windows) =="
	@echo "  タイルは gfx/ に CHR を置く。Mac では NEXXT を Wine で使うか、"
	@echo "  r-chr / PPUX などのネイティブ代替を使う。"
	@echo
	@echo "== sound (FamiStudio) =="
	@if [ -n "$(FAMISTUDIO_APP)" ]; then echo "$(FAMISTUDIO_APP)"; else \
		echo "MISSING: FamiStudio.app"; \
		echo "  https://famistudio.org/doc/install/  (macOS zip + .NET 8 x64)"; \
		echo "  出力は audio/ へ"; \
	fi
	@echo
	@echo "== editor =="
	@echo "  Cursor (VS Code 互換)。拡張: tlgkccampbell.code-ca65"
	@echo "rom: $(ROM)"
