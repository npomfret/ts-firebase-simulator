#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $(basename "$0") file-pattern [test-name]" >&2
    exit 1
}

FILE_PATTERN="${1-}" || true
[ -z "$FILE_PATTERN" ] && usage
TEST_NAME="${2-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || cd "$SCRIPT_DIR" && pwd)"
WORKSPACE_ROOT="$SCRIPT_DIR"

strip_workspace_prefix() {
    local pattern="$1"
    pattern="${pattern#./}"
    pattern="${pattern#$WORKSPACE_ROOT/}"
    local workspace_name
    workspace_name="$(basename "$WORKSPACE_ROOT")"
    if [[ "$pattern" == "$workspace_name/"* ]]; then
        pattern="${pattern#${workspace_name}/}"
    fi
    echo "$pattern"
}

resolve_with_fallback() {
    local search_root="$1"; shift
    local pattern="$1"; shift
    local -a candidates=("$@")

    for candidate in "${candidates[@]}"; do
        if [ -f "$search_root/$candidate" ]; then
            echo "$search_root/$candidate"
            return 0
        fi
    done

    if command -v fd >/dev/null 2>&1; then
        mapfile -t matches < <(cd "$search_root" && fd -g "*${pattern}*.test.ts" src --hidden --exclude node_modules)
    else
        mapfile -t matches < <(cd "$search_root" && find src -name "*${pattern}*.test.ts" -print 2>/dev/null)
    fi

    if [ "${#matches[@]}" -eq 1 ]; then
        echo "$search_root/${matches[0]}"
        return 0
    fi

    if [ "${#matches[@]}" -gt 1 ]; then
        echo "Multiple tests match '${pattern}':" >&2
        printf '  %s\n' "${matches[@]}" >&2
    else
        echo "No test file matching '${pattern}' found under $search_root/src" >&2
    fi
    exit 1
}

run_command_loop() {
    local repeat="${RUNS:-1}"
    local -a env_vars=()
    while [ "$#" -gt 0 ]; do
        if [ "$1" = "--" ]; then
            shift
            break
        fi
        env_vars+=("$1")
        shift
    done
    local -a cmd=("$@")

    for ((run=1; run<=repeat; run++)); do
        echo "Run ${run}/${repeat}: ${cmd[*]}"
        if ! (cd "$WORKSPACE_ROOT" && env "${env_vars[@]}" "${cmd[@]}"); then
            echo "Run ${run} failed" >&2
            return 1
        fi
    done
}

start_dev_server() {
    local host="${PLAYWRIGHT_DEV_HOST:-127.0.0.1}"
    DEV_PORT="${PLAYWRIGHT_DEV_PORT:-$(( (RANDOM % 10000) + 40000 ))}"
    local log_file
    log_file="$(mktemp -t webapp-dev-XXXX.log)"

    (cd "$WORKSPACE_ROOT" && npm run dev -- --host "$host" --port "$DEV_PORT" >"$log_file" 2>&1) &
    SERVER_PID=$!

    local attempts=0
    local max_attempts=120
    until curl -s "http://${host}:${DEV_PORT}/" >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ $attempts -ge $max_attempts ]; then
            echo "Failed to start dev server on http://${host}:${DEV_PORT}/" >&2
            cat "$log_file" >&2 || true
            return 1
        fi
        sleep 0.25
    done

    DEV_SERVER_LOG="$log_file"
}

cleanup() {
    if [ -n "${SERVER_PID-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" >/dev/null 2>&1 || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [ -n "${DEV_SERVER_LOG-}" ] && [ -f "$DEV_SERVER_LOG" ]; then
        rm -f "$DEV_SERVER_LOG"
    fi
}

trap cleanup EXIT

run_webapp_tests() {
    local pattern
    pattern="$(strip_workspace_prefix "$FILE_PATTERN")"
    local test_path
    test_path=$(resolve_with_fallback "$WORKSPACE_ROOT" "$pattern" \
        "$pattern" \
        "src/__tests__/integration/playwright/${pattern}" \
        "src/__tests__/integration/playwright/${pattern}.test.ts")

    start_dev_server
    local headed_flag=""
    [ "${HEADED:-0}" != "0" ] && headed_flag="--headed"

    local -a cmd=(npx playwright test "$test_path" --project=chromium --workers=1 --reporter=list --trace on)
    [ -n "$TEST_NAME" ] && cmd+=(--grep "$TEST_NAME")
    [ -n "$headed_flag" ] && cmd+=("$headed_flag")

    run_command_loop PLAYWRIGHT_EXTERNAL_SERVER=1 PLAYWRIGHT_DEV_PORT="$DEV_PORT" PLAYWRIGHT_HTML_OPEN=never -- "${cmd[@]}"
}

run_e2e_tests() {
    local pattern
    pattern="$(strip_workspace_prefix "$FILE_PATTERN")"
    local test_path
    test_path=$(resolve_with_fallback "$WORKSPACE_ROOT" "$pattern" \
        "$pattern" \
        "src/__tests__/integration/${pattern}" \
        "src/__tests__/integration/${pattern}.test.ts" \
        "src/__tests__/integration/${pattern}.e2e.test.ts" \
        "src/__tests__/unit/${pattern}" \
        "src/__tests__/unit/${pattern}.test.ts")

    if [[ "$test_path" == *"/unit/"* ]]; then
        local -a cmd=(npx jest "$test_path" --runInBand)
        [ -n "$TEST_NAME" ] && cmd+=(--testNamePattern "$TEST_NAME")
        run_command_loop -- "${cmd[@]}"
        return
    fi

    local headed_flag=""
    [ "${HEADED:-0}" != "0" ] && headed_flag="--headed"
    local report_dir="$WORKSPACE_ROOT/playwright-output/ad-hoc/report"
    local data_dir="$WORKSPACE_ROOT/playwright-output/ad-hoc/data"
    mkdir -p "$report_dir" "$data_dir"

    local -a cmd=(npx playwright test -c "$WORKSPACE_ROOT/playwright.config.ts" --project=chromium --workers=1 --reporter=html --trace on "$test_path")
    [ -n "$TEST_NAME" ] && cmd+=(--grep "$TEST_NAME")
    [ -n "$headed_flag" ] && cmd+=("$headed_flag")

    run_command_loop PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_REPORT="$report_dir" PLAYWRIGHT_TEST_OUTPUT_DIR="$data_dir" -- "${cmd[@]}"
}

run_functions_tests() {
    local pattern
    pattern="$(strip_workspace_prefix "$FILE_PATTERN")"
    local test_path
    test_path=$(resolve_with_fallback "$WORKSPACE_ROOT" "$pattern" \
        "$pattern" \
        "src/__tests__/${pattern}" \
        "src/__tests__/${pattern}.test.ts" \
        "src/__tests__/integration/${pattern}" \
        "src/__tests__/integration/${pattern}.test.ts" \
        "src/__tests__/unit/${pattern}" \
        "src/__tests__/unit/${pattern}.test.ts")

    local -a cmd=(npx vitest run "$test_path")
    [ -n "$TEST_NAME" ] && cmd+=(--grep "$TEST_NAME")

    if [[ "$test_path" == *"/integration/"* ]]; then
        echo "Preparing build for integration test..."
        (cd "$WORKSPACE_ROOT" && BUILD_MODE=test npm run build >/dev/null)
        run_command_loop BUILD_MODE=test -- "${cmd[@]}"
    else
        run_command_loop -- "${cmd[@]}"
    fi
}

run_generic_vitest() {
    local config_path="$1"
    local pattern
    pattern="$(strip_workspace_prefix "$FILE_PATTERN")"
    local test_path
    test_path=$(resolve_with_fallback "$WORKSPACE_ROOT" "$pattern" \
        "$pattern" \
        "src/__tests__/${pattern}" \
        "src/__tests__/${pattern}.test.ts")

    local -a cmd=(npx vitest run "$test_path")
    [ -n "$TEST_NAME" ] && cmd+=(--grep "$TEST_NAME")
    [ -n "$config_path" ] && cmd+=(--config "$config_path")

    run_command_loop -- "${cmd[@]}"
}

dispatch_from_root() {
    local -a candidates=(
        "e2e-tests"
        "webapp-v2"
        "firebase/functions"
        "packages/shared"
        "packages/firebase-simulator"
        "packages/test-support"
    )

    for candidate in "${candidates[@]}"; do
        local candidate_path="$PROJECT_ROOT/$candidate/run-test.sh"
        [ -x "$candidate_path" ] || continue
        if [[ "$FILE_PATTERN" == "$candidate"* ]]; then
            local forwarded="${FILE_PATTERN#${candidate}/}"
            exec "$candidate_path" "$forwarded" "$TEST_NAME"
        fi
        if [ -f "$PROJECT_ROOT/$candidate/$FILE_PATTERN" ] || [ -f "$PROJECT_ROOT/$candidate/src/$FILE_PATTERN" ]; then
            exec "$candidate_path" "$FILE_PATTERN" "$TEST_NAME"
        fi
    done

    echo "Unable to determine workspace for '$FILE_PATTERN'." >&2
    echo "Known src parents: ${candidates[*]}" >&2
    exit 1
}

main() {
    if [ ! -d "$WORKSPACE_ROOT/src" ]; then
        dispatch_from_root
        return
    fi

    local package_name
    package_name=$(node -e "console.log(require('${WORKSPACE_ROOT}/package.json').name)" 2>/dev/null || basename "$WORKSPACE_ROOT")

    case "$package_name" in
        webapp-v2)
            run_webapp_tests
            ;;
        "@billsplit-wl/e2e-tests")
            run_e2e_tests
            ;;
        functions)
            run_functions_tests
            ;;
        "@billsplit-wl/firebase-simulator")
            run_generic_vitest "$WORKSPACE_ROOT/vitest.config.ts"
            ;;
        "@billsplit-wl/shared"|"@billsplit-wl/test-support")
            run_generic_vitest ""
            ;;
        *)
            echo "Unsupported workspace context: $package_name" >&2
            exit 1
            ;;
    esac
}

main "$@"
