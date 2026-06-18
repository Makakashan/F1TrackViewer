#!/usr/bin/env python3
"""
generate-sector-splits.py

Derive real F1 sector split distances from FastF1 telemetry timing data.

Uses the median of multiple clean qualifying laps for stability:
  - For each clean quick lap, find the Distance at S1 and S2 split times
  - Take the median of all observed split distances
  - Write the result as a track-markers JSON file

Usage:
    pip install fastf1 pandas
    python generate-sector-splits.py

FastF1 supports event schedule data from 2018+.
"""

import json
import sys
from pathlib import Path

import fastf1
import pandas as pd

# Enable FastF1 cache
fastf1.Cache.enable_cache(".fastf1-cache")


def seconds(td):
    """Convert a timedelta to total seconds."""
    return td.total_seconds()


def interpolate_distance_at_time(telemetry, target_seconds):
    """
    Interpolate the Distance value in a telemetry DataFrame at a given
    elapsed time (in seconds from session start).

    FastF1 telemetry Time is usually a timedelta; we convert to seconds
    and do linear interpolation between the two nearest samples.
    """
    tel = telemetry.copy()

    # FastF1 telemetry Time is usually timedelta
    tel["t"] = tel["Time"].dt.total_seconds()

    before = tel[tel["t"] <= target_seconds].tail(1)
    after = tel[tel["t"] >= target_seconds].head(1)

    if before.empty or after.empty:
        raise ValueError("Cannot interpolate sector split — telemetry bounds exceeded")

    b = before.iloc[0]
    a = after.iloc[0]

    if a["t"] == b["t"]:
        return float(a["Distance"])

    ratio = (target_seconds - b["t"]) / (a["t"] - b["t"])
    return float(b["Distance"] + ratio * (a["Distance"] - b["Distance"]))


def generate_sector_splits(
    circuit_id: str,
    year: int,
    gp: str,
    session_name: str,
    driver: str,
    start_finish_s: float,
    direction_sign: int,
    lap_length_meters: float,
    num_laps: int = 10,
):
    """
    Generate sector split positions from FastF1 telemetry.

    Takes the median of `num_laps` clean quick laps for stability.
    Writes a JSON file to public/track-markers/{circuit_id}.json.
    """
    print(f"Loading session: {year} {gp} {session_name}...")
    session = fastf1.get_session(year, gp, session_name)
    session.load(laps=True, telemetry=True, weather=False, messages=False)

    laps = session.laps.pick_driver(driver).pick_quicklaps()
    if laps.empty:
        print(f"No quick laps found for {driver} in {year} {gp} {session_name}")
        sys.exit(1)

    split1_distances = []
    split2_distances = []

    for _, lap in laps.head(num_laps).iterrows():
        if pd.isna(lap["Sector1Time"]) or pd.isna(lap["Sector2Time"]):
            continue

        try:
            tel = lap.get_telemetry().add_distance()
        except Exception as e:
            print(f"  Skipping lap {lap['LapNumber']}: telemetry error: {e}")
            continue

        s1 = seconds(lap["Sector1Time"])
        s2 = seconds(lap["Sector2Time"])

        try:
            d1 = interpolate_distance_at_time(tel, s1)
            d2 = interpolate_distance_at_time(tel, s1 + s2)
            split1_distances.append(d1)
            split2_distances.append(d2)
            print(f"  Lap {int(lap['LapNumber'])}: S1={d1:.1f}m, S2={d2:.1f}m")
        except ValueError as e:
            print(f"  Skipping lap {lap['LapNumber']}: interpolation error: {e}")
            continue

    if not split1_distances or not split2_distances:
        print("Could not derive any sector splits from the available laps")
        sys.exit(1)

    s1_end = float(pd.Series(split1_distances).median())
    s2_end = float(pd.Series(split2_distances).median())

    print(f"\nMedian splits:")
    print(f"  S1 end: {s1_end:.2f}m")
    print(f"  S2 end: {s2_end:.2f}m")
    print(f"  S3 end: {lap_length_meters}m (lap length)")

    data = {
        "circuitId": circuit_id,
        "source": "fastf1-telemetry-derived",
        "year": year,
        "event": gp,
        "session": session_name,
        "driver": driver,
        "lapNumber": int(laps.pick_fastest()["LapNumber"]),
        "lapLengthMeters": lap_length_meters,
        "startFinish": {
            "s": start_finish_s,
            "verified": True,
        },
        "directionSign": direction_sign,
        "sectors": [
            {
                "id": 1,
                "fromDistance": 0,
                "toDistance": round(s1_end, 2),
                "color": "#00A3FF",
            },
            {
                "id": 2,
                "fromDistance": round(s1_end, 2),
                "toDistance": round(s2_end, 2),
                "color": "#B66DFF",
            },
            {
                "id": 3,
                "fromDistance": round(s2_end, 2),
                "toDistance": lap_length_meters,
                "color": "#00D084",
            },
        ],
    }

    out = Path("public/track-markers")
    out.mkdir(parents=True, exist_ok=True)

    out_path = out / f"{circuit_id}.json"
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"\nWritten to {out_path}")


# ─── Circuit definitions ──────────────────────────────────────────────
# Add more circuits here as needed. FastF1 supports 2018+ sessions.
# lapLengthMeters must match the GeoJSON track length for the viewer.

CIRCUITS = {
    "mc-1929": {
        "year": 2024,
        "gp": "Monaco",
        "session_name": "Q",
        "driver": "VER",
        "start_finish_s": 0.74108,
        "direction_sign": -1,
        "lap_length_meters": 3337,
    },
    # Future circuits — uncomment and adjust when ready:
    # "it-1922": {
    #     "year": 2024,
    #     "gp": "Monza",
    #     "session_name": "Q",
    #     "driver": "VER",
    #     "start_finish_s": 0.0,  # needs calibration
    #     "direction_sign": -1,
    #     "lap_length_meters": 5793,
    # },
    # "gb-1948": {
    #     "year": 2024,
    #     "gp": "Silverstone",
    #     "session_name": "Q",
    #     "driver": "VER",
    #     "start_finish_s": 0.53798,
    #     "direction_sign": 1,
    #     "lap_length_meters": 5891,
    # },
    # "be-1925": {
    #     "year": 2024,
    #     "gp": "Spa",
    #     "session_name": "Q",
    #     "driver": "VER",
    #     "start_finish_s": 0.0,  # needs calibration
    #     "direction_sign": -1,
    #     "lap_length_meters": 7004,
    # },
    # "jp-1962": {
    #     "year": 2024,
    #     "gp": "Suzuka",
    #     "session_name": "Q",
    #     "driver": "VER",
    #     "start_finish_s": 0.0,  # needs calibration
    #     "direction_sign": -1,
    #     "lap_length_meters": 5807,
    # },
}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # Generate specific circuit(s)
        for circuit_id in sys.argv[1:]:
            if circuit_id not in CIRCUITS:
                print(f"Unknown circuit: {circuit_id}")
                print(f"Available: {', '.join(CIRCUITS.keys())}")
                sys.exit(1)
            cfg = CIRCUITS[circuit_id]
            generate_sector_splits(
                circuit_id=circuit_id,
                **cfg,
            )
    else:
        # Generate all defined circuits
        for circuit_id, cfg in CIRCUITS.items():
            print(f"\n{'='*60}")
            print(f"Generating: {circuit_id}")
            print(f"{'='*60}")
            generate_sector_splits(
                circuit_id=circuit_id,
                **cfg,
            )
