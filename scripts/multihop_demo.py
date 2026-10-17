#!/usr/bin/env python3
"""Run a multi-hop mesh simulation — in the terminal, or live to the dashboard.

    python scripts/multihop_demo.py --topology chain --nodes 6
    python scripts/multihop_demo.py --topology geometric --nodes 12 --live

Without ``--live`` it prints the hop path and metrics. With ``--live`` it streams
every hop to the gateway so the coordinator dashboard can watch the report travel
node to node in real time.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "protocol"))

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from dms.sim import topology as topo  # noqa: E402
from dms.sim.multihop import ListSink, MultihopRun  # noqa: E402

DEFAULT_TEXT = "Three people trapped under collapsed building near Market Road"


def build_spec(args: argparse.Namespace) -> topo.TopologySpec:
    if args.topology == "chain":
        return topo.chain(args.nodes)
    if args.topology == "grid":
        return topo.grid(args.width, args.height)
    if args.topology == "geometric":
        return topo.random_geometric(args.nodes, radius=args.radius, seed=args.seed)
    raise SystemExit(f"unknown topology {args.topology!r}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--topology", choices=["chain", "grid", "geometric"], default="chain")
    p.add_argument("--nodes", type=int, default=6)
    p.add_argument("--width", type=int, default=3)
    p.add_argument("--height", type=int, default=3)
    p.add_argument("--radius", type=float, default=0.4)
    p.add_argument("--seed", type=int, default=20260831)
    p.add_argument("--text", default=DEFAULT_TEXT)
    p.add_argument("--live", action="store_true", help="stream to the gateway dashboard")
    p.add_argument("--gateway", default="http://localhost:8000")
    p.add_argument("--api-key", default=None)
    p.add_argument("--step-delay", type=float, default=0.0, help="pause per hop, for watching")
    args = p.parse_args()

    spec = build_spec(args)
    sinks: list = []
    list_sink = ListSink()
    sinks.append(list_sink)

    http_sink = None
    if args.live:
        from dms.sim.stream import HttpSink

        http_sink = HttpSink(args.gateway, spec.to_snapshot(), api_key=args.api_key)
        if http_sink.run_id is None:
            print(f"! could not reach gateway at {args.gateway}; running offline")
        else:
            print(f"streaming run {http_sink.run_id} → {args.gateway}")
        sinks.append(http_sink)

    tmp = Path(tempfile.mkdtemp(prefix="multihop_"))
    mesh = topo.build_mesh(spec, tmp)
    try:
        run = MultihopRun(mesh, spec, sinks=sinks, step_delay=args.step_delay)
        run.emit_topology()
        run.inject_report(spec.nodes[0].id, args.text)
        metrics = run.run()
    finally:
        mesh.stop()

    if http_sink is not None:
        http_sink.flush(metrics=metrics.to_dict(), done=True)

    print(f"\ntopology : {spec.name}  ({len(spec.nodes)} nodes, {len(spec.edges)} links)")
    print("hop path :")
    for e in list_sink.events:
        if e.type == "hop":
            print(f"   {' → '.join(e.path)}   (hop {e.hop})")
        elif e.type == "delivered":
            print(f"   ✓ delivered to {e.to_node}")
        elif e.type == "duplicate_suppressed":
            print(f"   × duplicate suppressed at {e.to_node}")
    m = metrics.to_dict()
    print("\nmetrics  :")
    for k in ("delivered", "expected", "delivery_ratio", "avg_hops", "max_hops",
              "bundles_transferred", "duplicates_suppressed", "rounds"):
        print(f"   {k:22} {m[k]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
