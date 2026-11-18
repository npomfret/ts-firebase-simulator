#!/usr/bin/env python3
"""Run the shared TeamCity CLI, wherever this machine keeps it.

Copy this to `scripts/teamcity.py` in a project. The implementation lives in the
`teamcity` plugin of npomfret/agent-standards; this file only finds it, so that
`npm run tc:*` behaves the same for a person at a shell and for an agent inside
a session. Everything project-specific is `.teamcity/cli.json`.

Update the installed plugin through Claude's supported plugin commands.
"""

from __future__ import annotations

import json
import runpy
import sys
from pathlib import Path

def version_of(path: Path) -> tuple:
    """The cache directory's version, as something that sorts numerically."""
    parts = path.parent.parent.name.split(".")
    return tuple(int(p) if p.isdigit() else -1 for p in parts)


def installed(plugins: Path):
    """Where this machine says the plugin is installed, newest record first.

    This is the only authority on which copy is current. A cache directory
    outlives the marketplace it came from, and an orphan from a retired
    marketplace sorts ahead of the live one as readily as behind it.
    """
    try:
        data = json.loads((plugins / "installed_plugins.json").read_text())
    except (OSError, ValueError):
        return
    for key, entries in (data.get("plugins") or {}).items():
        if key.split("@")[0] != "teamcity":
            continue
        for entry in sorted(entries, key=lambda e: e.get("lastUpdated", ""), reverse=True):
            if entry.get("installPath"):
                yield Path(entry["installPath"]) / "scripts" / "teamcity.py"


def candidates(plugins: Path):
    yield from installed(plugins)
    # Then whatever is cached, by version rather than by path: sorting the paths
    # ranks the marketplace name ahead of the version, which is how a retired
    # marketplace's 1.0.0 came to shadow the live 1.0.1.
    yield from sorted(
        plugins.glob("cache/*/teamcity/*/scripts/teamcity.py"), key=version_of, reverse=True
    )
    yield from sorted(plugins.glob("marketplaces/*/plugins/teamcity/scripts/teamcity.py"))


def main() -> int:
    plugins = Path.home() / ".claude" / "plugins"
    for candidate in candidates(plugins):
        if candidate.is_file():
            sys.argv[0] = str(candidate)
            runpy.run_path(str(candidate), run_name="__main__")
            return 0
    sys.exit(
        "The shared TeamCity CLI is not on this machine. Install it with:\n"
        "  claude plugin marketplace add npomfret/agent-standards\n"
        "  claude plugin install teamcity@npomfret"
    )


if __name__ == "__main__":
    raise SystemExit(main())
