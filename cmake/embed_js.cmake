# Embed a JS file as a C byte array.
# Usage: cmake -DINPUT=foo.js -DOUTPUT=foo.h -P embed_js.cmake

if(NOT INPUT OR NOT OUTPUT)
    message(FATAL_ERROR "embed_js.cmake: INPUT and OUTPUT are required")
endif()

file(READ "${INPUT}" content HEX)
string(LENGTH "${content}" hexlen)
math(EXPR nbytes "${hexlen} / 2")

# Prefix every byte in a single regex pass. A per-byte foreach loop spends
# minutes on a few hundred KiB of bootstrap code.
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${content}")
if(nbytes GREATER 0)
    string(LENGTH "${bytes}" byteslen)
    math(EXPR byteslen "${byteslen} - 1")
    string(SUBSTRING "${bytes}" 0 ${byteslen} bytes)
    # Wrap at 12 bytes per line, like xxd.
    string(REGEX REPLACE
        "(0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],0x[0-9a-f][0-9a-f],)"
        "\\1\n" bytes "${bytes}")
endif()

get_filename_component(basename "${INPUT}" NAME_WE)
string(MAKE_C_IDENTIFIER "${basename}" ident)

file(WRITE "${OUTPUT}"
    "/* generated from ${basename}.js -- do not edit */\n"
    "unsigned char ${ident}_js[] = {\n${bytes}\n};\n"
    "unsigned int ${ident}_js_len = ${nbytes};\n")
