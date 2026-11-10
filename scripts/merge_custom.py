#!/usr/bin/env python3
# Merges the upstream list_v2.json with our custom additions.
# The combined result goes to list_v2_combined.json (the app fetches THIS file),
# so the upstream list_v2.json stays pristine and upstream syncs never conflict.
import json
import os


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    base = load("list_v2.json")
    custom_path = os.path.join("custom", "custom_v2.json")
    custom_sources = []
    if os.path.exists(custom_path):
        try:
            custom = load(custom_path)
            custom_sources = custom.get("sources", []) or []
        except Exception as e:
            print("WARNING: bad custom_v2.json:", e)
    if custom_sources:
        base.setdefault("sources", []).extend(custom_sources)
        print("custom sources appended:", len(custom_sources))
    out_path = "list_v2_combined.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, indent=1)
    print("written:", out_path, "sources total:", len(base.get("sources", [])))


if __name__ == "__main__":
    main()
