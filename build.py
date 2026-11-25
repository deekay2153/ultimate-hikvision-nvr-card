"""Build dist/ultimate-nvr-card.js from src/.

    python build.py

One module, in this order:
  1. joystick.js    the PTZ joystick (arcane-ptz-joystick, defined only if
                    another copy has not been loaded already)
  2. base-card.js   the recorder card from techmarkai/hikvision-nvr-ha (MIT),
                    renamed to ultimate-nvr-card so it never clashes with the
                    integration's own hikvision-nvr-card
  3. fast-live.js   live player, gestures, timeline and the wall layout
  4. wall-extras.js PTZ placement, rings, clock, REC buttons, event tags
  5. ultimate.js    defaults, zero config, joystick through the integration

The layers patch the card's prototype once it is defined. In one file the
definition comes first, so they always apply before any card is drawn.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "dist" / "ultimate-nvr-card.js"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]

OLD_TAG = "hikvision-nvr-card"
NEW_TAG = "ultimate-nvr-card"


def base_card() -> str:
    s = (SRC / "base-card.js").read_text(encoding="utf-8")
    # The integration's card answers to these names; ours must not.
    alias = re.compile(
        r"\n  // Alias: `type: custom:hikvision-card`[^\n]*\n[^\n]*\n"
        r"  customElements\.define\(\"hikvision-card\", class extends HikvisionNvrCard \{\}\);\n"
    )
    s, n = alias.subn("\n", s)
    assert n == 1, "alias block not found"
    picker = re.compile(r"\nwindow\.customCards = window\.customCards \|\| \[\];\n.*\Z", re.S)
    s, n = picker.subn("\n", s)
    assert n == 1, "card picker block not found"
    # Version from the build, not from the URL (HACS adds its own ?hacstag=).
    s, n = re.subn(
        r"const CARD_VERSION =\n  new URL\(import\.meta\.url\)\.searchParams\.get\(\"v\"\) \|\| \"dev\";",
        f'const CARD_VERSION = "{VERSION}";',
        s,
    )
    assert n == 1, "version line not found"
    s = s.replace("HIKVISION-NVR-CARD", "ULTIMATE-NVR-CARD")
    return s.replace(OLD_TAG, NEW_TAG)


def layer(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8").replace(OLD_TAG, NEW_TAG)


def main() -> None:
    parts = [
        ("joystick.js", (SRC / "joystick.js").read_text(encoding="utf-8")),
        ("base-card.js", base_card()),
        ("fast-live.js", layer("fast-live.js")),
        ("wall-extras.js", layer("wall-extras.js")),
        ("ultimate.js", layer("ultimate.js")),
    ]
    header = (
        f"/*! Ultimate Hikvision NVR card {VERSION}\n"
        " * https://github.com/deekay2153/ultimate-hikvision-nvr-card\n"
        " * MIT licence. Contains the Hikvision NVR card by techmarkai\n"
        " * (https://github.com/techmarkai/hikvision-nvr-ha, MIT) and the Arcane PTZ\n"
        " * joystick (https://github.com/deekay2153/arcane-ptz-joystick, MIT).\n"
        " * Not affiliated with or endorsed by Hikvision.\n"
        " */\n"
    )
    # Each part keeps its own scope: the sources share top-level names (API,
    # clamp, ...) that would clash in one module.
    body = "".join(f"\n// ---- {name} ----\n{{\n{text}\n}}\n" for name, text in parts)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(header + body, encoding="utf-8", newline="\n")
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()[:12]
    print(f"{OUT.relative_to(ROOT)}  {OUT.stat().st_size:,} bytes  sha256 {digest}")


if __name__ == "__main__":
    main()
