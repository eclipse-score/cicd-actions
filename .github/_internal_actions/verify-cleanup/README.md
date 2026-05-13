# verify-cleanup

## Description

This JavaScript-based GitHub Action is `used only for internal testing purposes` in order to verify that cleanup operations done by other actions (for example, `setup-qnx-sdp`) were successful. It checks for the presence of files and environment variables that should have been removed or unset by cleanup operations, and fails if any of them are found.
