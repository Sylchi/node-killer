# Runner image for the pre-commit act hook.
#
# The build only needs Node.js, which the stock act image already provides.
# Keep this image so the hook can pin and reuse a known runner.
ARG ACT_BASE_IMAGE=catthehacker/ubuntu:act-latest
FROM ${ACT_BASE_IMAGE}
