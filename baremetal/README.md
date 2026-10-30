# qnode Bare-Metal Kernel for Raspberry Pi 4

A bare-metal JavaScript runtime for Pi 4B with 7" touchscreen, running without Linux.

## Overview

This is a freestanding ARM64 kernel that boots directly on Raspberry Pi 4 hardware,
providing a Node.js-compatible environment with Web Platform APIs — no Linux kernel
required.

The project leverages the existing qnode codebase:
- **QuickJS** engine (JavaScript runtime)
- **netstack** (in-process TCP/IP stack, OS-independent)
- **libev** (event loop)
- **mbedtls/libsodium** (TLS/crypto)

## Current Status: Phase 2 ✅ (LVGL Boot UI added)

Phase 1 implements the minimal boot environment:

| Component | Status | Description |
|-----------|--------|-------------|
| `start.S` | ✅ Done | ARM64 entry, exception vectors, BSS clear |
| `linker.ld` | ✅ Done | Memory layout, 0x80000 load address |
| `bcm2711.h` | ✅ Done | Hardware register definitions |
| `uart.c/h` | ✅ Done | PL011 UART driver (115200 8N1) |
| `timer.c/h` | ✅ Done | System timer (1 MHz microsecond counter) |
| `main.c` | ✅ Done | Boot sequence, LVGL loop, keyboard → JS bridge |
| `lvgl.c/h` | ✅ Done | LVGL display/input integration + boot UI |
| `js.c/h` | ✅ Done | QuickJS runtime/context, console.log, JS helpers |
| `mailbox.c/h` | ✅ Done | VideoCore mailbox interface |
| `framebuffer.c/h` | ✅ Done | Framebuffer driver (800x480 @ 32bpp) |
| `config.txt` | ✅ Done | Pi 4 boot configuration |
| `Makefile` | ✅ Done | Cross-compilation build system |

## LVGL Integration (Pi Boot UI)

The kernel now uses [LVGL](https://github.com/lvgl/lvgl) (v9.2) as the graphics
framework instead of drawing raw pixel patterns:

- `src/lvgl.c/h` — LVGL integration driver:
  - Creates an LVGL display (800x480) via the mailbox framebuffer
  - `lvgl_flush_cb` copies the rendered LVGL draw buffer into the framebuffer
  - Wires the FT5406 touch controller into LVGL as a pointer input device
  - Builds a boot UI: splash (spinner + "Starting...") with an on-screen keyboard
    (LVGL `lv_keyboard` + `lv_textarea`) below it
- `lvgl/lv_conf.h` — LVGL configuration (enabled with `#if 1`, color depth 32 /
  XRGB8888, 512 KB LVGL memory pool)
- `Makefile` — compiles the LVGL library sources (`find ../lvgl/src -name '*.c' ...`)

The main loop calls `lvgl_step()` (tick + `lv_timer_handler`), so the LVGL
refresh timer drives rendering automatically (LVGL timers + animations).

The on-screen keyboard: LVGL `lv_keyboard` (text mode) is assigned to an
`lv_textarea` — key presses (incl. backspace via `LV_SYMBOL_BACKSPACE`) are
inserted into the text area.

Whenever the keyboard text changes, `lvgl_step()` reports it via the callback
registered with `lvgl_set_keyboard_text_cb()` (in `src/lvgl.c`). The callback in
`src/main.c` (`kb_text_cb`) forwards the text to the UART boot console *and*
pushes it into the QuickJS runtime as the global `kbInput` string via
`js_push_global_str()`.

## JavaScript Engine (`src/js.c/h`)

QuickJS is encapsulated behind a small module, so `src/main.c` never touches
`JSRuntime`/`JSContext` directly:

- `js_init()` — creates the runtime/context, registers the C-backed
  `console.log` global (output goes to the UART) and evaluates the boot
  test program
- `js_step()` — drains pending QuickJS jobs (GC finalizers, promise jobs) via
  `JS_ExecutePendingJob()`; call it from the main loop
- `js_push_global_str(name, value)` — sets a string property on the JS global
  object (used by the on-screen keyboard bridge)

To change the boot UI, edit the splash screen in `src/lvgl.c` (`lvgl_init`) and
rebuild with `cd baremetal && make`.

## Building

Requires `aarch64-none-elf-gcc` cross-compiler.

```bash
cd baremetal
make
```

Output: `kernel8.img`

## Booting on Pi 4

Create a FAT32 boot partition on SD card with these files:

1. **From Raspberry Pi firmware** (get from [rpi-firmware](https://github.com/raspberrypi/firmware)):
   - `bootcode.bin`
   - `start.elf` (or `start4.elf` for Pi 4)
   - `fixup.dat` (or `fixup4.dat`)

2. **Config file** — `config.txt`:
   ```
   arm_64bit=1
   enable_uart=1
   kernel=kernel8.img
   
   # Disable BT UART to free up PL011
   dtoverlay=disable-bt
   ```

3. **Our kernel**:
   - `kernel8.img` (built from this project)

Insert SD card, power on Pi 4. Connect USB serial to GPIO 14/15 (TX/RX) at 115200 baud.

## Expected Output

### Phase 1 Output (UART):
```
========================================
qnode bare-metal kernel for Pi 4
========================================

Phase 1: UART initialized
Timer frequency: 1 MHz

Testing timer... delayed for ~1000000 us (expected ~1000000)

Phase 1 complete. Entering main loop...
Type characters to see them echoed back (Ctrl+C to halt)
```

### Phase 2 Output (Display):
```
========================================
qnode bare-metal kernel for Pi 4
Phase 2: Display Support
========================================

Initializing framebuffer...
Requesting 800x480 @ 32bpp
SUCCESS: Framebuffer initialized
Base address: 0x...
Size: 1536000 bytes
Pitch: 3200 bytes/row

Initializing LVGL...
SUCCESS: LVGL initialized, boot screen displayed.

LVGL rendering active. Boot screen displayed.
UART echo active. Type characters to see them echoed.
```

The display should show the LVGL boot splash screen (spinner + "Starting...").

## Roadmap

### Phase 1 — Boot Infrastructure ✅
- ARM64 boot code (start.S)
- PL011 UART driver
- System timer
- Heap allocator
- Cross-compilation setup

### Phase 2 — Display ✅
- VideoCore mailbox driver
- Framebuffer (800x480 RGB)
- LVGL rendering via flush callback

### Phase 3 — Touch Input ✅
- FT5406 touch controller driver
- LVGL pointer input device integration
- Touch event handling
- Input abstraction layer

### Phase 4 — JS Runtime
- libev virtual fd polling backend
- QuickJS integration with UART console
- setTimeout/setInterval support
- Web API polyfills

### Phase 5 — Storage + Network
- SD card driver (SDHOST or mailbox)
- FAT32 reader (read-only, or Petit FATFS)
- Ethernet (GENET MAC) → plug into netstack
- WiFi (optional, via SDIO)

## LVGL Boot UI

The Pi boot display is rendered by LVGL:

- **Display**: LVGL display (800x480, XRGB8888) on top of the mailbox framebuffer,
  flush callback copies the rendered frame into the framebuffer
- **Input**: FT5406 touch → LVGL `LV_INDEV_TYPE_POINTER` (timer-driven read)
- **UI**: Boot UI in `baremetal/src/lvgl.c` (`lvgl_init`):
  - Splash: dark background, centered spinner (1s arc animation) + "Starting..." label
  - On-screen keyboard: LVGL `lv_keyboard` (text mode) with `lv_textarea` below the splash
- **Loop**: main loop calls `lvgl_step()` → LVGL tick + `lv_timer_handler()`

To customize the boot screen (logo, text, keyboard layout), edit `baremetal/src/lvgl.c`
and rebuild: `cd baremetal && make`.

## Memory Map

```
0x00000000 - 0x0007FFFF : Reserved (GPU)
0x00080000 - ???         : Kernel image (loaded by firmware)
??? - 0x00080000         : Stack (64KB, grows down)
0xFE000000 - 0xFFFFFFFF : BCM2711 peripherals
0xFF800000 - 0xFF8FFFFF : ARM local peripherals (GIC, timers)
```

## License

Same as qnode (MIT).
