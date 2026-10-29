# Concatenate the qnode bootstrap parts into one script.
# Usage: cmake -DINPUT_DIR=bootstrap -DOUTPUT=node_bootstrap.js -P concat_js.cmake
#
# The parts are plain scripts rather than modules: they share one top-level
# scope once concatenated. Filename order defines execution order, hence the
# numeric prefixes.

if(NOT INPUT_DIR OR NOT OUTPUT)
    message(FATAL_ERROR "concat_js.cmake: INPUT_DIR and OUTPUT are required")
endif()

file(GLOB parts "${INPUT_DIR}/*.js")
list(SORT parts)

set(content "")
foreach(part ${parts})
    file(READ "${part}" chunk)
    string(APPEND content "${chunk}")
endforeach()

file(WRITE "${OUTPUT}" "${content}")
