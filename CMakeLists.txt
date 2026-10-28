cmake_minimum_required(VERSION 3.13)

project(quickjs LANGUAGES C)

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
    set(QJS_WASM3 TRUE)
    message(STATUS "  wasm3: vendored (static)")
else()
    set(QJS_WASM3 FALSE)
endif()

# libev is vendored and statically linked into the core library. It backs
# quickjs-libc's event loop (io, timers, signals) on POSIX platforms.
if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "WASI" AND NOT EMSCRIPTEN)
    list(APPEND qjs_sources vendor/libev/ev.c)
    list(APPEND qjs_defines EV_STANDALONE QJS_HAVE_LIBEV)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        # libev only auto-selects epoll when it detects glibc; musl has
        # epoll as well, so make it explicit instead of falling back to
        # the O(n) poll backend on static musl builds.
        list(APPEND qjs_defines EV_USE_EPOLL=1)
    endif()
    message(STATUS "  libev: vendored (static)")
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

#
# quickjs-libc
#

add_library(qjs-libc STATIC quickjs-libc.c)
target_compile_definitions(qjs-libc PRIVATE ${qjs_defines})
target_link_libraries(qjs-libc PRIVATE ${qjs_libs} qjs)

# qnode embeds the JS bootstrap as a C array. xxd ships with vim; fall back
# to a CMake-generated header when it is unavailable.
find_program(XXD_EXECUTABLE xxd)
set(NODE_BOOTSTRAP_H ${CMAKE_CURRENT_BINARY_DIR}/node_bootstrap.h)
if(XXD_EXECUTABLE)
    add_custom_command(
        OUTPUT ${NODE_BOOTSTRAP_H}
        COMMAND ${XXD_EXECUTABLE} -i -n node_bootstrap_js
                ${CMAKE_CURRENT_SOURCE_DIR}/node_bootstrap.js
                ${NODE_BOOTSTRAP_H}
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/node_bootstrap.js
        COMMENT "Embedding node_bootstrap.js"
        VERBATIM
    )
else()
    add_custom_command(
        OUTPUT ${NODE_BOOTSTRAP_H}
        COMMAND ${CMAKE_COMMAND} -DINPUT=${CMAKE_CURRENT_SOURCE_DIR}/node_bootstrap.js
                -DOUTPUT=${NODE_BOOTSTRAP_H}
                -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_js.cmake
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/node_bootstrap.js
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
    # qnode compiles the vendored zlib and mbedTLS sources in-tree and links
    # them statically, so the build has no external TLS or compression
    # dependencies.
    set(QNODE_ZLIB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/zlib)
    add_library(qnode_zlib STATIC
        ${QNODE_ZLIB_DIR}/adler32.c
        ${QNODE_ZLIB_DIR}/compress.c
        ${QNODE_ZLIB_DIR}/crc32.c
        ${QNODE_ZLIB_DIR}/deflate.c
        ${QNODE_ZLIB_DIR}/gzclose.c
        ${QNODE_ZLIB_DIR}/gzlib.c
        ${QNODE_ZLIB_DIR}/gzread.c
        ${QNODE_ZLIB_DIR}/gzwrite.c
        ${QNODE_ZLIB_DIR}/infback.c
        ${QNODE_ZLIB_DIR}/inffast.c
        ${QNODE_ZLIB_DIR}/inflate.c
        ${QNODE_ZLIB_DIR}/inftrees.c
        ${QNODE_ZLIB_DIR}/trees.c
        ${QNODE_ZLIB_DIR}/uncompr.c
        ${QNODE_ZLIB_DIR}/zutil.c
    )
    target_include_directories(qnode_zlib PUBLIC ${QNODE_ZLIB_DIR})
    target_compile_definitions(qnode_zlib PUBLIC _LARGEFILE64_SOURCE=1)

    set(QNODE_MBEDTLS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/mbedtls)
    file(GLOB QNODE_MBEDTLS_SOURCES CONFIGURE_DEPENDS
        ${QNODE_MBEDTLS_DIR}/library/*.c)
    add_library(qnode_mbedtls STATIC ${QNODE_MBEDTLS_SOURCES})
    target_include_directories(qnode_mbedtls PUBLIC
        ${QNODE_MBEDTLS_DIR}/include)

    add_library(qnode_core STATIC node.c)
    target_compile_definitions(qnode_core PRIVATE ${qjs_defines})
    target_include_directories(qnode_core PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
    target_link_libraries(qnode_core PRIVATE qjs qjs-libc
        qnode_zlib qnode_mbedtls)
    add_dependencies(qnode_core node_bootstrap_header)

    add_executable(qnode_exe qnode.c)
    set_target_properties(qnode_exe PROPERTIES
        OUTPUT_NAME "qnode"
        PDB_NAME "qnode"
        COMPILE_PDB_NAME "qnode"
    )
    target_compile_definitions(qnode_exe PRIVATE ${qjs_defines})
    target_link_libraries(qnode_exe PRIVATE qnode_core)
    target_link_options(qnode_exe PRIVATE -static)
endif()

#
# QuickJS bytecode compiler
#

add_executable(qjsc
    qjsc.c
)
target_compile_definitions(qjsc PRIVATE ${qjs_defines})
target_link_libraries(qjsc PRIVATE qjs qjs-libc)
if(MINGW)
    target_link_options(qjsc PRIVATE -static -static-libgcc)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_options(qjsc PRIVATE -static)
endif()


#
# QuickJS CLI
#

add_executable(qjs_exe
    gen/repl.c
    gen/standalone.c
    qjs.c
)
set_target_properties(qjs_exe PROPERTIES
    OUTPUT_NAME "qjs"
    PDB_NAME "qjs_cli"
    COMPILE_PDB_NAME "qjs_cli"
)
target_compile_definitions(qjs_exe PRIVATE ${qjs_defines})
target_link_libraries(qjs_exe PRIVATE qjs qjs-libc)
if (NOT WIN32)
    set_target_properties(qjs_exe PROPERTIES ENABLE_EXPORTS TRUE)
endif()
if(MINGW)
    target_link_options(qjs_exe PRIVATE -static -static-libgcc)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_options(qjs_exe PRIVATE -static)
endif()

if(EMSCRIPTEN)
    add_executable(qjs_wasm ${qjs_sources} quickjs-libc.c)
    target_link_options(qjs_wasm PRIVATE
        # in emscripten 3.x, this will be set to 16k which is too small for quickjs. #write sth. to force github rebuild
        -sSTACK_SIZE=2097152 # let it be 2m = 2 * 1024 * 1024 = 2097152, otherwise, stack overflow may be occured at bootstrap
        -sNO_INVOKE_RUN
        -sNO_EXIT_RUNTIME
        -sMODULARIZE # do not mess the global
        -sEXPORT_ES6 # export js file to morden es module
        -sEXPORT_NAME=getQuickJs # give a name
        -sTEXTDECODER=1 # it will be 2 if we use -Oz, and that will cause js -> c string convertion fail
        -sNO_DEFAULT_TO_CXX # this project is pure c project, no need for c plus plus handle
        -sEXPORTED_RUNTIME_METHODS=ccall,cwrap
    )
    target_compile_definitions(qjs_wasm PRIVATE ${qjs_defines} QJS_BUILD_LIBC)
    target_link_libraries(qjs_wasm PRIVATE m)
endif()

# WASI Reactor
#

if(CMAKE_SYSTEM_NAME STREQUAL "WASI")
    option(QJS_WASI_REACTOR "Build WASI reactor (exports library functions, no _start)" OFF)
    if(QJS_WASI_REACTOR)
        add_executable(qjs_wasi
            quickjs-libc.c
            qjs-wasi-reactor.c
        )
        set_target_properties(qjs_wasi PROPERTIES
            OUTPUT_NAME "qjs"
            SUFFIX ".wasm"
        )
        target_compile_definitions(qjs PRIVATE BUILDING_QJS_SHARED)
        target_compile_definitions(qjs_wasi PRIVATE ${qjs_defines} BUILDING_QJS_SHARED)
        target_link_libraries(qjs_wasi qjs)
        target_link_options(qjs_wasi PRIVATE
            -mexec-model=reactor
            # Export all symbols with default visibility (JS_EXTERN functions)
            -Wl,--export-dynamic
            # Memory management (libc symbols need explicit export)
            -Wl,--export=malloc
            -Wl,--export=free
            -Wl,--export=realloc
            -Wl,--export=calloc
            # Enable hosts to pass callbacks to JS_SetInterruptHandler,
            # JS_SetModuleLoaderFunc2, etc.
            -Wl,--export-table
            -Wl,--growable-table
        )
    endif()
endif()

# Test262 runner
#

if(NOT EMSCRIPTEN)
    add_executable(run-test262
        run-test262.c
    )
    target_compile_definitions(run-test262 PRIVATE ${qjs_defines})
    target_link_libraries(run-test262 PRIVATE qjs qjs-libc)
endif()

# C API tests
#

add_executable(api-test
    api-test.c
)
target_compile_definitions(api-test PRIVATE ${qjs_defines})
target_link_libraries(api-test PRIVATE qjs qjs-libc)

add_executable(lre-test
    lre-test.c
    libregexp.c
    libunicode.c
)
target_compile_definitions(lre-test PRIVATE ${qjs_defines})

# Unicode generator
#

# Note: do not link libunicode.c here, it needs the generated libunicode-table.h,
# which would make it impossible to regenerate the table from scratch.
add_executable(unicode_gen EXCLUDE_FROM_ALL
    unicode_gen.c
)
target_compile_definitions(unicode_gen PRIVATE ${qjs_defines})

add_executable(function_source
    gen/function_source.c
)
target_include_directories(function_source PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(function_source PRIVATE ${qjs_defines})
target_link_libraries(function_source PRIVATE qjs qjs-libc)

# Install target
#

file(STRINGS quickjs.h quickjs_h REGEX QJS_VERSION)
string(REGEX MATCH "QJS_VERSION_MAJOR ([0-9]*)" _ "${quickjs_h}")
set(QJS_VERSION_MAJOR ${CMAKE_MATCH_1})
string(REGEX MATCH "QJS_VERSION_MINOR ([0-9]*)" _ "${quickjs_h}")
set(QJS_VERSION_MINOR ${CMAKE_MATCH_1})
string(REGEX MATCH "QJS_VERSION_PATCH ([0-9]*)" _ "${quickjs_h}")
set(QJS_VERSION_PATCH ${CMAKE_MATCH_1})
set_target_properties(qjs PROPERTIES
    VERSION ${QJS_VERSION_MAJOR}.${QJS_VERSION_MINOR}.${QJS_VERSION_PATCH}
    SOVERSION ${QJS_VERSION_MAJOR}
)
install(FILES quickjs.h qjs-wasm.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
if(NOT IOS AND NOT TVOS AND NOT WATCHOS)
    install(TARGETS qjs_exe RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
    install(TARGETS qjsc RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
    install(FILES qjs.man DESTINATION ${CMAKE_INSTALL_DATADIR}/man/man1 RENAME qjs.1)
    install(FILES qjsc.man DESTINATION ${CMAKE_INSTALL_DATADIR}/man/man1 RENAME qjsc.1)
endif()
install(TARGETS qjs EXPORT qjsConfig
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
install(EXPORT qjsConfig DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/qjs)
install(FILES LICENSE DESTINATION ${CMAKE_INSTALL_DOCDIR})
install(DIRECTORY examples DESTINATION ${CMAKE_INSTALL_DOCDIR})
