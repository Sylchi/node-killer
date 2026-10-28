# Embed a JS file as a C byte array.
# Usage: cmake -DINPUT=foo.js -DOUTPUT=foo.h -P embed_js.cmake

if(NOT INPUT OR NOT OUTPUT)
    message(FATAL_ERROR "embed_js.cmake: INPUT and OUTPUT are required")
endif()

file(READ "${INPUT}" content HEX)
string(LENGTH "${content}" hexlen)
math(EXPR nbytes "${hexlen} / 2")

set(bytes "")
set(line "")
math(EXPR last "${nbytes} - 1")
if(nbytes GREATER 0)
    foreach(i RANGE 0 ${last})
        math(EXPR off "${i} * 2")
        string(SUBSTRING "${content}" ${off} 2 byte)
        if(line STREQUAL "")
            set(line "  0x${byte}")
        else()
            set(line "${line}, 0x${byte}")
        endif()
        math(EXPR col "${i} % 12")
        if(col EQUAL 11)
            set(bytes "${bytes}${line},\n")
            set(line "")
        endif()
    endforeach()
endif()
if(NOT line STREQUAL "")
    set(bytes "${bytes}${line}\n")
endif()

get_filename_component(basename "${INPUT}" NAME_WE)
string(MAKE_C_IDENTIFIER "${basename}" ident)

file(WRITE "${OUTPUT}"
    "/* generated from ${basename}.js -- do not edit */\n"
    "unsigned char ${ident}_js[] = {\n${bytes}};\n"
    "unsigned int ${ident}_js_len = ${nbytes};\n")
