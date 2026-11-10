#!/usr/bin/env python3
# Merges the upstream list with our custom additions into list_v2_combined.json.
# Inputs (placed in the runner's working dir by the workflow): upstream_list.json + custom_v2.json.
# The upstream list_v2.json in the repo is also refreshed (the workflow commits it via API).
import json
import os


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    base = load("upstream_list.json")
    custom_sources = []
    if os.path.exists("custom_v2.json"):
        try:
            custom = load("custom_v2.json")
            custom_sources = custom.get("sources", []) or []
        except Exception as e:
            print("WARNING: bad custom_v2.json:", e)
    if custom_sources:
        base.setdefault("sources", []).extend(custom_sources)
        print("custom sources appended:", len(custom_sources))
    with open("list_v2_combined.json", "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, indent=1)
    print("written: list_v2_combined.json, sources total:", len(base.get("sources", [])))


if __name__ == "__main__":
    main()
