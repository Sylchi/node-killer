# Runner image for the pre-commit act hook.
#
# The stock act image does not ship cmake or xxd. Installing them on every
# hook run costs more than the 30 second budget. Bake them in once instead.
# zig is checked in at vendor/zig/, so it does not need to be installed here.
ARG ACT_BASE_IMAGE=catthehacker/ubuntu:act-latest
FROM ${ACT_BASE_IMAGE}

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cmake xxd \
    && rm -rf /var/lib/apt/lists/*
