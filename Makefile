#
# QuickJS Javascript Engine
#
# Copyright (c) 2017-2026 Fabrice Bellard
# Copyright (c) 2017-2024 Charlie Gordon
# Copyright (c) 2023-2026 Ben Noordhuis
# Copyright (c) 2023-2026 Saúl Ibarra Corretgé
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

BUILD_DIR?=build
BUILD_TYPE?=Release
JOBS?=$(shell getconf _NPROCESSORS_ONLN)
ifeq ($(JOBS),)
JOBS := $(shell nproc)
endif
ifeq ($(JOBS),)
JOBS := 4
endif

QNODE=$(BUILD_DIR)/qnode
QJSC=$(BUILD_DIR)/qjsc

all: $(QNODE)

$(BUILD_DIR):
	cmake -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=$(BUILD_TYPE)

$(QNODE): $(BUILD_DIR)
	cmake --build $(BUILD_DIR) --target qnode_exe -j $(JOBS)

$(QJSC): $(BUILD_DIR)
	cmake --build $(BUILD_DIR) --target qjsc -j $(JOBS)

clean:
	cmake --build $(BUILD_DIR) --target clean 2>/dev/null || rm -rf $(BUILD_DIR)

distclean:
	rm -rf $(BUILD_DIR)

codegen: $(QJSC)
	$(QJSC) -C -ss -o builtin-array-fromasync.h builtin-array-fromasync.js
	$(QJSC) -C -ss -o builtin-iterator-zip.h builtin-iterator-zip.js
	$(QJSC) -C -ss -o builtin-iterator-zip-keyed.h builtin-iterator-zip-keyed.js

debug:
	BUILD_TYPE=Debug $(MAKE)

qnode-test: $(QNODE)
	QNODE=$(abspath $(QNODE)) $(CURDIR)/tests/run-qnode-tests.sh

net-test: $(QNODE)
	QNODE=$(abspath $(QNODE)) $(CURDIR)/tests/qnode/net_shards.sh

net-bench: $(QNODE)
	QNODE=$(abspath $(QNODE)) $(CURDIR)/benchmarks/net-shards/bench.sh

netstack-tun-test: $(QNODE)
	QNODE=$(abspath $(QNODE)) sh $(CURDIR)/tests/qnode/netstack_tun.sh

netstack-tap-test: $(QNODE)
	QNODE=$(abspath $(QNODE)) sh $(CURDIR)/tests/qnode/netstack_tap.sh

.PHONY: all clean distclean debug codegen qnode-test net-test net-bench netstack-tun-test netstack-tap-test $(QNODE) $(QJSC)
