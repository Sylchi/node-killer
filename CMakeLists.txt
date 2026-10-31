cmake_minimum_required(VERSION 3.13)

# qnode links prebuilt archives that are built for Linux with zig's bundled
# musl libc. Selecting zig here keeps the same archives usable on glibc and
# musl hosts instead of maintaining one archive set per libc. An explicit
# compiler, CC, or toolchain file always wins; without zig the build falls
# back to the host compiler and qnode is disabled.
if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux"
   AND NOT CMAKE_C_COMPILER
   AND NOT DEFINED ENV{CC}
   AND NOT CMAKE_TOOLCHAIN_FILE
   AND NOT CMAKE_CROSSCOMPILING)
    set(QNODE_ZIG_HOST_ARCH "${CMAKE_HOST_SYSTEM_PROCESSOR}")
    if(NOT QNODE_ZIG_HOST_ARCH)
        execute_process(COMMAND uname -m
            OUTPUT_VARIABLE QNODE_ZIG_HOST_ARCH
            OUTPUT_STRIP_TRAILING_WHITESPACE)
    endif()
    string(TOLOWER "${QNODE_ZIG_HOST_ARCH}" QNODE_ZIG_ARCH)
    if(QNODE_ZIG_ARCH MATCHES "^(amd64|x86_64)$")
        set(QNODE_ZIG_ARCH x86_64)
    elseif(QNODE_ZIG_ARCH MATCHES "^(arm64|aarch64)$")
        set(QNODE_ZIG_ARCH aarch64)
    elseif(QNODE_ZIG_ARCH MATCHES "^(i[3-6]86|x86)$")
        set(QNODE_ZIG_ARCH x86)
    endif()
    # Prefer the checked-in static zig toolchain (x86-64 only); fall back to
    # an installed zig otherwise.
    if(QNODE_ZIG_ARCH STREQUAL "x86_64"
       AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/zig/zig")
        set(QNODE_ZIG "${CMAKE_CURRENT_SOURCE_DIR}/vendor/zig/zig")
    else()
        find_program(QNODE_ZIG NAMES zig)
    endif()
    if(QNODE_ZIG)
        set(CMAKE_C_COMPILER "${QNODE_ZIG}" CACHE FILEPATH "C compiler")
        set(CMAKE_C_COMPILER_ARG1 "cc" CACHE STRING
            "Extra argument passed to the C compiler")
        set(CMAKE_C_FLAGS_INIT "-target ${QNODE_ZIG_ARCH}-linux-musl")
        set(QNODE_ZIG_TARGET "${QNODE_ZIG_ARCH}-linux-musl")
        set(QNODE_ZIG_ARCH "${QNODE_ZIG_ARCH}" CACHE INTERNAL
            "Host architecture for the zig musl target")
        message(STATUS "Using zig cc (${QNODE_ZIG_TARGET})")
    endif()
endif()

project(quickjs LANGUAGES C)

# CMake's Makefile generator asks the linker for a dependency file. zig's
# linker driver crashes on the generated `-Xlinker --dependency-file` flag, so
# fall back to CMake's own link dependency tracking for zig builds.
get_filename_component(QNODE_C_COMPILER_NAME "${CMAKE_C_COMPILER}" NAME)
string(TOLOWER "${QNODE_C_COMPILER_NAME}" QNODE_C_COMPILER_NAME)
if(QNODE_C_COMPILER_NAME MATCHES "^zig(\\.exe)?$")
    set(CMAKE_LINK_DEPENDS_USE_LINKER FALSE)
endif()

include(CheckCCompilerFlag)
include(GNUInstallDirs)

set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_C_STANDARD 11)

if(NOT CMAKE_BUILD_TYPE)
    message(STATUS "No build type selected, default to Release")
    set(CMAKE_BUILD_TYPE "Release")
endif()

message(STATUS "Building in ${CMAKE_BUILD_TYPE} mode")
message(STATUS "Building with ${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION} on ${CMAKE_SYSTEM}")

# MINGW doesn't exist in older cmake versions, newer versions don't know
# about CMAKE_COMPILER_IS_MINGW, and there is no unique CMAKE_C_COMPILER_ID
# for mingw-based compilers...
if(MINGW)
    # do nothing
elseif(CMAKE_C_COMPILER MATCHES "mingw")
    set(MINGW TRUE)
else()
    set(MINGW FALSE)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "tvOS")
    set(TVOS TRUE)
else()
    set(TVOS FALSE)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "watchOS")
    set(WATCHOS TRUE)
else()
    set(WATCHOS FALSE)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "SunOS")
    set(SUNOS TRUE)
else()
    set(SUNOS FALSE)
endif()

macro(xcheck_add_c_compiler_flag FLAG)
    string(REPLACE "-" "" FLAG_NO_HYPHEN ${FLAG})
    check_c_compiler_flag(${FLAG} COMPILER_SUPPORTS_${FLAG_NO_HYPHEN})
    if(COMPILER_SUPPORTS_${FLAG_NO_HYPHEN})
        add_compile_options(${FLAG})
    endif()
endmacro()

xcheck_add_c_compiler_flag(-Wall)
if(NOT MSVC AND NOT IOS AND NOT TVOS AND NOT WATCHOS)
    xcheck_add_c_compiler_flag(-Wextra)
endif()
xcheck_add_c_compiler_flag(-Wformat=2)
xcheck_add_c_compiler_flag(-Wno-implicit-fallthrough)
xcheck_add_c_compiler_flag(-Wno-sign-compare)
xcheck_add_c_compiler_flag(-Wno-missing-field-initializers)
xcheck_add_c_compiler_flag(-Wno-unused-parameter)
xcheck_add_c_compiler_flag(-Wno-unused-but-set-variable)
xcheck_add_c_compiler_flag(-Wno-unused-result)
xcheck_add_c_compiler_flag(-Wno-stringop-truncation)
xcheck_add_c_compiler_flag(-Wno-array-bounds)
if(NOT SUNOS)
    xcheck_add_c_compiler_flag(-funsigned-char)
endif()

# Clang on Windows without MSVC command line fails because the codebase uses
# functions like strcpy over strcpy_s
if(CMAKE_C_COMPILER_ID STREQUAL "Clang" AND WIN32 AND NOT MSVC)
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS)
    add_compile_definitions(_CRT_NONSTDC_NO_DEPRECATE)
endif()

# ClangCL is command line compatible with MSVC, so 'MSVC' is set.
if(MSVC)
    xcheck_add_c_compiler_flag(-Wno-unsafe-buffer-usage)
    xcheck_add_c_compiler_flag(-Wno-sign-conversion)
    xcheck_add_c_compiler_flag(-Wno-nonportable-system-include-path)
    xcheck_add_c_compiler_flag(-Wno-implicit-int-conversion)
    xcheck_add_c_compiler_flag(-Wno-shorten-64-to-32)
    xcheck_add_c_compiler_flag(-Wno-reserved-macro-identifier)
    xcheck_add_c_compiler_flag(-Wno-reserved-identifier)
    xcheck_add_c_compiler_flag(-Wdeprecated-declarations)
    xcheck_add_c_compiler_flag(/experimental:c11atomics)
    xcheck_add_c_compiler_flag(/wd4018) # -Wno-sign-conversion
    xcheck_add_c_compiler_flag(/wd4061) # -Wno-implicit-fallthrough
    xcheck_add_c_compiler_flag(/wd4100) # -Wno-unused-parameter
    xcheck_add_c_compiler_flag(/wd4200) # -Wno-zero-length-array
    xcheck_add_c_compiler_flag(/wd4242) # -Wno-shorten-64-to-32
    xcheck_add_c_compiler_flag(/wd4244) # -Wno-shorten-64-to-32
    xcheck_add_c_compiler_flag(/wd4245) # -Wno-sign-compare
    xcheck_add_c_compiler_flag(/wd4267) # -Wno-shorten-64-to-32
    xcheck_add_c_compiler_flag(/wd4388) # -Wno-sign-compare
    xcheck_add_c_compiler_flag(/wd4389) # -Wno-sign-compare
    xcheck_add_c_compiler_flag(/wd4456) # Hides previous local declaration
    xcheck_add_c_compiler_flag(/wd4457) # Hides function parameter
    xcheck_add_c_compiler_flag(/wd4710) # Function not inlined
    xcheck_add_c_compiler_flag(/wd4711) # Function was inlined
    xcheck_add_c_compiler_flag(/wd4820) # Padding added after construct
    xcheck_add_c_compiler_flag(/wd4996) # -Wdeprecated-declarations
    xcheck_add_c_compiler_flag(/wd5045) # Compiler will insert Spectre mitigation for memory load if /Qspectre switch specified
endif()

# Set a 8MB default stack size on Windows.
# It defaults to 1MB on MSVC, which is the same as our current JS stack size,
# so it will overflow and crash otherwise.
# On MinGW it defaults to 2MB.
if(WIN32)
    if(MSVC)
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} /STACK:8388608")
    elseif(CMAKE_C_COMPILER_ID MATCHES "Clang" AND NOT MINGW)
        # Clang frontend (clang.exe) targeting the MSVC ABI (using lld-link)
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Xlinker /STACK:8388608")
    else()
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Wl,--stack,8388608")
    endif()
endif()

# MacOS and GCC 11 or later need -Wno-maybe-uninitialized
# https://github.com/quickjs-ng/quickjs/issues/453
if(APPLE AND CMAKE_C_COMPILER_ID STREQUAL "GNU" AND CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL 11)
    xcheck_add_c_compiler_flag(-Wno-maybe-uninitialized)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "WASI")
    add_compile_definitions(
        _WASI_EMULATED_PROCESS_CLOCKS
        _WASI_EMULATED_SIGNAL
    )
    add_link_options(
        -Wl,-z,stack-size=2097152
        -lwasi-emulated-process-clocks
        -lwasi-emulated-signal
    )
endif()

if(CMAKE_BUILD_TYPE MATCHES "Debug")
    xcheck_add_c_compiler_flag(/Od)
    xcheck_add_c_compiler_flag(-O0)
    xcheck_add_c_compiler_flag(-ggdb)
    xcheck_add_c_compiler_flag(-fno-omit-frame-pointer)
endif()

#
# Prebuilt dependency archives
#
# zlib, mbedTLS, libsodium, libev and wasm3 are vendored but do not change
# with qnode. They are linked from static archives in
# vendor/prebuilt/<os>-<arch>/, so their sources are not compiled on every
# build. The archives are produced by zig cc for <arch>-linux-musl; zig
# supplies the libc, so a single archive set works on every Linux host.
# libev and wasm3 keep their sources because they are also compiled for WASI,
# Emscripten, Windows and macOS; zlib, mbedTLS and libsodium ship as headers
# plus archives only.
set(QNODE_PREBUILT_DIR "")
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Archives are compiled by zig for <arch>-linux-musl; any other compiler
    # would use the host libc, so qnode stays disabled for those builds.
    get_filename_component(QNODE_C_COMPILER_NAME "${CMAKE_C_COMPILER}" NAME)
    string(TOLOWER "${QNODE_C_COMPILER_NAME}" QNODE_C_COMPILER_NAME)
    if(QNODE_C_COMPILER_NAME MATCHES "^zig(\\.exe)?$")
        string(TOLOWER "${CMAKE_SYSTEM_NAME}" QNODE_PREBUILT_OS)
        set(QNODE_PREBUILT_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
        if(NOT QNODE_PREBUILT_ARCH)
            set(QNODE_PREBUILT_ARCH "${QNODE_ZIG_ARCH}")
        endif()
        if(NOT QNODE_PREBUILT_ARCH)
            execute_process(COMMAND uname -m
                OUTPUT_VARIABLE QNODE_PREBUILT_ARCH
                OUTPUT_STRIP_TRAILING_WHITESPACE)
        endif()
        string(TOLOWER "${QNODE_PREBUILT_ARCH}" QNODE_PREBUILT_ARCH)
        set(QNODE_PREBUILT_DIR
            ${CMAKE_CURRENT_SOURCE_DIR}/vendor/prebuilt/${QNODE_PREBUILT_OS}-${QNODE_PREBUILT_ARCH})
    endif()
endif()

if(QNODE_PREBUILT_DIR AND EXISTS ${QNODE_PREBUILT_DIR})
    message(STATUS "Using prebuilt dependencies from ${QNODE_PREBUILT_DIR}")

    function(qnode_import_prebuilt name archive)
        set(archive_path ${QNODE_PREBUILT_DIR}/${archive})
        if(NOT EXISTS ${archive_path})
            message(FATAL_ERROR
                "missing prebuilt archive ${archive_path}; see vendor/README.md "
                "for the supported targets and how to regenerate the archives")
        endif()
        add_library(${name} STATIC IMPORTED)
        set_target_properties(${name} PROPERTIES
            IMPORTED_LOCATION ${archive_path})
    endfunction()

    # libev and wasm3 keep their sources, so only use their archives when the
    # host has one. The other three libraries are archive-only.
    if(EXISTS ${QNODE_PREBUILT_DIR}/libqnode_libev.a)
        set(QNODE_PREBUILT_LIBEV TRUE)
    endif()
    if(EXISTS ${QNODE_PREBUILT_DIR}/libqnode_wasm3.a)
        set(QNODE_PREBUILT_WASM3 TRUE)
    endif()
    # quickjs, like the libraries above, is upstream code that does not change
    # with qnode. A prebuilt archive keeps its 2 MB quickjs.c translation unit
    # off the build's critical path. Rebuild the archive when quickjs.c or a
    # header it includes changes, see vendor/README.md.
    option(QNODE_USE_PREBUILT_QJS
        "Link quickjs from vendor/prebuilt instead of compiling its sources" ON)
    if(QNODE_USE_PREBUILT_QJS AND EXISTS ${QNODE_PREBUILT_DIR}/libqjs.a)
        set(QNODE_PREBUILT_QJS TRUE)
    endif()
endif()


#
# QuickJS library
#

set(qjs_sources
    dtoa.c
    libregexp.c
    libunicode.c
    quickjs.c
    qjs-wasm.c
)

# wasm3 is vendored and always compiled in so WebAssembly.instantiate() and
# WASI modules work without a separate runtime. The only exception is a build
# that is itself WebAssembly.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "WASI" AND NOT EMSCRIPTEN)
    if(QNODE_PREBUILT_WASM3)
        qnode_import_prebuilt(qnode_wasm3 libqnode_wasm3.a)
        list(APPEND qjs_prebuilt_libs qnode_wasm3)
        message(STATUS "  wasm3: prebuilt (static)")
    else()
        set(wasm3_sources
            vendor/wasm3/source/m3_bind.c
            vendor/wasm3/source/m3_code.c
            vendor/wasm3/source/m3_compile.c
            vendor/wasm3/source/m3_core.c
            vendor/wasm3/source/m3_deterministic.c
            vendor/wasm3/source/m3_env.c
            vendor/wasm3/source/m3_exec.c
            vendor/wasm3/source/m3_function.c
            vendor/wasm3/source/m3_info.c
            vendor/wasm3/source/m3_module.c
            vendor/wasm3/source/m3_parse.c
            vendor/wasm3/source/m3_snapshot.c
            vendor/wasm3/source/m3_validate.c
            vendor/wasm3/source/m3_xxh64.c
            vendor/wasm3/source/m3_api_wasi.c
        )
        # An object library keeps the vendored objects inside libqjs without
        # adding a second installable target to the export set.
        add_library(wasm3 OBJECT ${wasm3_sources})
        set_target_properties(wasm3 PROPERTIES POSITION_INDEPENDENT_CODE ON)
        target_include_directories(wasm3 PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}/vendor/wasm3/source
        )
        # The "simple" WASI backend talks to POSIX directly, so it does not pull in
        # libuv/uvwasi. d_m3HasFloat is on by default but spelled out because the
        # JS bridge assumes it.
        target_compile_definitions(wasm3 PRIVATE
            d_m3HasWASI
            d_m3HasFloat=1
            _GNU_SOURCE
        )
        if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
            # wasm3 is not built clean under every warning the host project turns on.
            target_compile_options(wasm3 PRIVATE
                -Wno-unused-parameter
                -Wno-unused-function
                -Wno-sign-compare
            )
        endif()
        list(APPEND qjs_sources $<TARGET_OBJECTS:wasm3>)
        message(STATUS "  wasm3: vendored (static)")
    endif()
    set(QJS_WASM3 TRUE)
else()
    set(QJS_WASM3 FALSE)
endif()

# libev is vendored and statically linked into the core library. It backs
# quickjs-libc's event loop (io, timers, signals) on POSIX platforms.
if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "WASI" AND NOT EMSCRIPTEN)
    if(QNODE_PREBUILT_LIBEV)
        qnode_import_prebuilt(qnode_libev libqnode_libev.a)
        list(APPEND qjs_prebuilt_libs qnode_libev)
        message(STATUS "  libev: prebuilt (static)")
    else()
        list(APPEND qjs_sources vendor/libev/ev.c)
        message(STATUS "  libev: vendored (static)")
    endif()
    list(APPEND qjs_defines EV_STANDALONE QJS_HAVE_LIBEV)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        # libev only auto-selects epoll when it detects glibc; musl has
        # epoll as well, so make it explicit instead of falling back to
        # the O(n) poll backend on static musl builds.
        list(APPEND qjs_defines EV_USE_EPOLL=1)
    endif()
endif()

list(APPEND qjs_defines _GNU_SOURCE)
if(WIN32)
    # NB: Windows 7 is EOL and we are only supporting in so far as it doesn't interfere with progress.
    list(APPEND qjs_defines WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601)
else()
    # UNIX-y platforms.
    list(APPEND qjs_libs m)
endif()
if(TVOS)
    list(APPEND qjs_defines _TVOS)
endif()
if(WATCHOS)
    list(APPEND qjs_defines _WATCHOS)
endif()
list(APPEND qjs_libs ${CMAKE_DL_LIBS})
find_package(Threads)
if(NOT CMAKE_SYSTEM_NAME STREQUAL "WASI")
    list(APPEND qjs_libs ${CMAKE_THREAD_LIBS_INIT})
endif()
list(APPEND qjs_libs ${qjs_prebuilt_libs})

if(QNODE_PREBUILT_QJS)
    # Link quickjs from the checked-in archive instead of compiling its sources.
    # The archive is built from the same sources and flags; see vendor/README.md
    # for the regeneration command after touching quickjs.c or its headers.
    qnode_import_prebuilt(qjs libqjs.a)
    set_target_properties(qjs PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES
            "${CMAKE_CURRENT_SOURCE_DIR};${CMAKE_CURRENT_SOURCE_DIR}/vendor/libev;${CMAKE_CURRENT_SOURCE_DIR}/vendor/wasm3/source"
    )
    target_link_libraries(qjs INTERFACE ${qjs_libs})
    message(STATUS "  quickjs: prebuilt (static)")
else()
    add_library(qjs STATIC ${qjs_sources})
    target_compile_definitions(qjs PRIVATE ${qjs_defines})
    if(QJS_WASM3)
        target_compile_definitions(qjs PRIVATE QJS_BUILD_WASM3)
    endif()
    target_include_directories(qjs PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/vendor/libev>
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/vendor/wasm3/source>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
    )
    target_link_libraries(qjs PUBLIC ${qjs_libs})
    message(STATUS "  quickjs: compiled from source")
endif()

# qnode embeds the JS bootstrap as a C array. The bootstrap lives in
# bootstrap/ as ordered parts that are concatenated into one script (they
# share a top-level scope). xxd ships with vim; fall back to a CMake-generated
# header when it is unavailable.
find_program(XXD_EXECUTABLE xxd)
set(NODE_BOOTSTRAP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/bootstrap)
file(GLOB NODE_BOOTSTRAP_PARTS CONFIGURE_DEPENDS ${NODE_BOOTSTRAP_DIR}/*.js)
list(SORT NODE_BOOTSTRAP_PARTS)
set(NODE_BOOTSTRAP_JS ${CMAKE_CURRENT_BINARY_DIR}/node_bootstrap.js)
set(NODE_BOOTSTRAP_H ${CMAKE_CURRENT_BINARY_DIR}/node_bootstrap.h)
add_custom_command(
    OUTPUT ${NODE_BOOTSTRAP_JS}
    COMMAND ${CMAKE_COMMAND} -DINPUT_DIR=${NODE_BOOTSTRAP_DIR}
            -DOUTPUT=${NODE_BOOTSTRAP_JS}
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/concat_js.cmake
    DEPENDS ${NODE_BOOTSTRAP_PARTS}
    COMMENT "Concatenating node bootstrap"
    VERBATIM
)
if(XXD_EXECUTABLE)
    add_custom_command(
        OUTPUT ${NODE_BOOTSTRAP_H}
        COMMAND ${XXD_EXECUTABLE} -i -n node_bootstrap_js
                ${NODE_BOOTSTRAP_JS}
                ${NODE_BOOTSTRAP_H}
        DEPENDS ${NODE_BOOTSTRAP_JS}
        COMMENT "Embedding node_bootstrap.js"
        VERBATIM
    )
else()
    add_custom_command(
        OUTPUT ${NODE_BOOTSTRAP_H}
        COMMAND ${CMAKE_COMMAND} -DINPUT=${NODE_BOOTSTRAP_JS}
                -DOUTPUT=${NODE_BOOTSTRAP_H}
                -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_js.cmake
        DEPENDS ${NODE_BOOTSTRAP_JS}
        COMMENT "Embedding node_bootstrap.js (cmake fallback)"
        VERBATIM
    )
endif()
add_custom_target(node_bootstrap_header DEPENDS ${NODE_BOOTSTRAP_H})
# node.c includes the generated header, but some generators do not pick up
# generated headers from depfiles on the first build. Make the dependency
# explicit so bootstrap edits always recompile node.c.
set_source_files_properties(node.c PROPERTIES OBJECT_DEPENDS ${NODE_BOOTSTRAP_H})

#
# qnode (Linux)
#

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # zlib, mbedTLS and libsodium are shipped as headers plus prebuilt static
    # archives; their sources are not part of the tree. They do not change
    # with qnode, so keeping them precompiled avoids rebuilding ~250 C files
    # on every build. See vendor/README.md for versions, supported targets,
    # and how to regenerate the archives after an upgrade.
    if(NOT QNODE_PREBUILT_DIR OR NOT EXISTS ${QNODE_PREBUILT_DIR})
        # Keep other targets buildable for qjs/qjsc; qnode needs the archived
        # crypto/compression libraries.
        message(STATUS
            "  qnode: disabled (no prebuilt archives for "
            "${CMAKE_SYSTEM_NAME} ${CMAKE_SYSTEM_PROCESSOR}; install zig so "
            "CMake can build for <arch>-linux-musl)")
    else()

    qnode_import_prebuilt(qnode_zlib libqnode_zlib.a)
    set_target_properties(qnode_zlib PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES ${CMAKE_CURRENT_SOURCE_DIR}/vendor/zlib
        INTERFACE_COMPILE_DEFINITIONS _LARGEFILE64_SOURCE=1)

    qnode_import_prebuilt(qnode_mbedtls libqnode_mbedtls.a)
    set_target_properties(qnode_mbedtls PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES ${CMAKE_CURRENT_SOURCE_DIR}/vendor/mbedtls/include)

    # libsodium is used for Ed25519, which the vendored mbedTLS build does
    # not provide.
    qnode_import_prebuilt(qnode_sodium libqnode_sodium.a)
    set_target_properties(qnode_sodium PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/vendor/libsodium/src/libsodium/include;${CMAKE_CURRENT_SOURCE_DIR}/vendor/libsodium/src/libsodium/include/sodium"
        INTERFACE_LINK_LIBRARIES Threads::Threads)

    add_library(qnode_core STATIC node.c netstack.c netstack_l2.c
        netstack_link.c node_netstack.c quickjs-libc.c)
    target_compile_definitions(qnode_core PRIVATE ${qjs_defines} QNODE_FREESTANDING)
    target_include_directories(qnode_core PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
    target_link_libraries(qnode_core PRIVATE qjs
        qnode_zlib qnode_mbedtls qnode_sodium)
    add_dependencies(qnode_core node_bootstrap_header)

    add_executable(qnode_exe qnode.c)
    set_target_properties(qnode_exe PROPERTIES
        OUTPUT_NAME "qnode"
        PDB_NAME "qnode"
        COMPILE_PDB_NAME "qnode"
    )
    target_compile_definitions(qnode_exe PRIVATE ${qjs_defines} QNODE_FREESTANDING)
    target_link_libraries(qnode_exe PRIVATE qnode_core)
    target_link_options(qnode_exe PRIVATE -static)
    endif()
endif()

#
# Keep qjsc for bootstrap/codegen if needed
#

add_executable(qjsc
    qjsc.c
    quickjs-libc.c
)
target_compile_definitions(qjsc PRIVATE ${qjs_defines})
target_link_libraries(qjsc PRIVATE qjs)
if(MINGW)
    target_link_options(qjsc PRIVATE -static -static-libgcc)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_options(qjsc PRIVATE -static)
endif()
