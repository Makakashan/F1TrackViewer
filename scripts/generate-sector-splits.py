#!/usr/bin/env python3
"""
generate-sector-splits.py

Derive real F1 sector split distances from FastF1 telemetry timing data,
or generate approximate 33/33/33 splits for historical circuits without
FastF1 data.

Uses the median of multiple clean qualifying laps for stability:
  - For each clean quick lap, find the Distance at S1 and S2 split times
  - Take the median of all observed split distances
  - Write the result as a track-markers JSON file

For circuits without FastF1 data (pre-2018 or never in F1 calendar),
generates equal 33/33/33 sector splits as a fallback.

Usage:
    pip install fastf1 pandas
    python generate-sector-splits.py                    # all circuits
    python generate-sector-splits.py mc-1929 gb-1948   # specific circuits
    python generate-sector-splits.py --fastf1-only      # only circuits with FastF1 data
    python generate-sector-splits.py --manual-only      # only manually defined splits

FastF1 supports event schedule data from 2018+.
"""

import json
import sys
from pathlib import Path

import fastf1
import pandas as pd

# Enable FastF1 cache
FASTF1_CACHE_DIR = Path(".fastf1-cache")
FASTF1_CACHE_DIR.mkdir(parents=True, exist_ok=True)
fastf1.Cache.enable_cache(str(FASTF1_CACHE_DIR))

SECTOR_COLORS = ["#00A3FF", "#B66DFF", "#00D084"]


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
    start_finish_verified: bool = False,
    direction_verified: bool = False,
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
            "verified": start_finish_verified,
        },
        "directionSign": direction_sign,
        "verification": {
            "startFinish": start_finish_verified,
            "direction": direction_verified,
            "sectors": True,
        },
        "sectors": [
            {
                "id": 1,
                "fromDistance": 0,
                "toDistance": round(s1_end, 2),
                "color": SECTOR_COLORS[0],
            },
            {
                "id": 2,
                "fromDistance": round(s1_end, 2),
                "toDistance": round(s2_end, 2),
                "color": SECTOR_COLORS[1],
            },
            {
                "id": 3,
                "fromDistance": round(s2_end, 2),
                "toDistance": lap_length_meters,
                "color": SECTOR_COLORS[2],
            },
        ],
    }

    _write_marker_file(circuit_id, data)


def generate_manual_sector_splits(
    circuit_id: str,
    start_finish_s: float,
    direction_sign: int,
    lap_length_meters: float,
    start_finish_verified: bool = False,
    direction_verified: bool = False,
    note: str = "",
):
    """
    Generate approximate 33/33/33 sector splits for circuits without
    FastF1 telemetry data. This is a fallback for historical circuits
    or circuits that have never been in the F1 calendar.
    """
    s1_end = round(lap_length_meters / 3, 2)
    s2_end = round(2 * lap_length_meters / 3, 2)

    print(f"Equal-thirds splits for {circuit_id}:")
    print(f"  S1 end: {s1_end:.2f}m")
    print(f"  S2 end: {s2_end:.2f}m")
    print(f"  S3 end: {lap_length_meters}m (lap length)")

    data = {
        "circuitId": circuit_id,
        "source": "equal-thirds",
        "lapLengthMeters": lap_length_meters,
        "startFinish": {
            "s": start_finish_s,
            "verified": start_finish_verified,
        },
        "directionSign": direction_sign,
        "verification": {
            "startFinish": start_finish_verified,
            "direction": direction_verified,
            "sectors": False,
        },
        "confidence": "low",
        "sectors": [
            {
                "id": 1,
                "fromDistance": 0,
                "toDistance": s1_end,
                "color": SECTOR_COLORS[0],
            },
            {
                "id": 2,
                "fromDistance": s1_end,
                "toDistance": s2_end,
                "color": SECTOR_COLORS[1],
            },
            {
                "id": 3,
                "fromDistance": s2_end,
                "toDistance": lap_length_meters,
                "color": SECTOR_COLORS[2],
            },
        ],
    }

    if note:
        data["note"] = note

    _write_marker_file(circuit_id, data)


def _write_marker_file(circuit_id: str, data: dict):
    """Write a track-markers JSON file."""
    out = Path("public/track-markers")
    out.mkdir(parents=True, exist_ok=True)
    out_path = out / f"{circuit_id}.json"
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"\nWritten to {out_path}")


# ─── Circuit definitions ──────────────────────────────────────────────
#
# Source circuits from the bacinger/f1-circuits dataset.
#
# Track lengths are from the GeoJSON properties (CircuitProperties.length).
# start_finish_s values are from START_FINISH_OVERRIDES in start-finish.ts.
#
# direction_sign:
#   +1 = GeoJSON coordinates trace the track in the racing direction
#   -1 = GeoJSON coordinates trace the track opposite to the racing direction
#
# IMPORTANT: direction_sign values are ESTIMATES for most circuits.
# Only mc-1929 (Monaco) has been verified with actual FastF1 telemetry.
# All other values should be verified by running the script and checking
# that sector colors appear in the correct positions on the rendered track.
# If sectors appear in the wrong order (S3 where S1 should be), flip the sign.
#
# Circuits without a FastF1 session should only be kept in the app when their
# split distances are manually verified. Synthetic equal-split layouts
# are filtered out of the viewer.
#
# FastF1 event names use the official F1 event name as stored by FastF1.
# For the 2024 season these are the country/event names from the schedule.

CIRCUITS = {
    # ─── 2024 F1 Calendar (24 races) ─────────────────────────────────
    "bh-2002": {
        "year": 2024, "gp": "Bahrain", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5412,
        "start_finish_verified": False, "direction_verified": False,
    },  # Bahrain International Circuit (Sakhir)
    "sa-2021": {
        "year": 2024, "gp": "Saudi Arabia", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 6175,
        "start_finish_verified": False, "direction_verified": False,
    },  # Jeddah Corniche Circuit (Jeddah)
    "au-1953": {
        "year": 2024, "gp": "Australia", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5278,
        "start_finish_verified": False, "direction_verified": False,
    },  # Albert Park Circuit (Melbourne)
    "jp-1962": {
        "year": 2024, "gp": "Japan", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5807,
        "start_finish_verified": False, "direction_verified": False,
    },  # Suzuka International Racing Course (Suzuka)
    "cn-2004": {
        "year": 2024, "gp": "China", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0.9469, "direction_sign": 1, "lap_length_meters": 5451,
        "start_finish_verified": True, "direction_verified": False,
    },  # Shanghai International Circuit (Shanghai)
    "us-2022": {
        "year": 2024, "gp": "Miami", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5412,
        "start_finish_verified": False, "direction_verified": False,
    },  # Miami International Autodrome (Miami)
    "it-1953": {
        "year": 2024, "gp": "Emilia Romagna", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4909,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autodromo Enzo e Dino Ferrari (Imola)
    "mc-1929": {
        "year": 2024, "gp": "Monaco", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0.74108, "direction_sign": -1, "lap_length_meters": 3337,
        "start_finish_verified": True, "direction_verified": True,
    },  # Circuit de Monaco (Monaco) — VERIFIED direction_sign
    "ca-1978": {
        "year": 2024, "gp": "Canada", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4361,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuit Gilles-Villeneuve (Montreal)
    "es-1991": {
        "year": 2024, "gp": "Spain", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0.032, "direction_sign": 1, "lap_length_meters": 4655,
        "start_finish_verified": True, "direction_verified": False,
    },  # Circuit de Barcelona-Catalunya (Barcelona)
    "at-1969": {
        "year": 2024, "gp": "Austria", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4318,
        "start_finish_verified": False, "direction_verified": False,
    },  # Red Bull Ring (Spielberg)
    "gb-1948": {
        "year": 2024, "gp": "Great Britain", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0.53798, "direction_sign": 1, "lap_length_meters": 5891,
        "start_finish_verified": True, "direction_verified": False,
    },  # Silverstone Circuit (Silverstone)
    "hu-1986": {
        "year": 2024, "gp": "Hungary", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4381,
        "start_finish_verified": False, "direction_verified": False,
    },  # Hungaroring (Budapest)
    "be-1925": {
        "year": 2024, "gp": "Belgium", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 7004,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuit de Spa-Francorchamps (Spa)
    "nl-1948": {
        "year": 2024, "gp": "Netherlands", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4259,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuit Zandvoort (Zandvoort)
    "it-1922": {
        "year": 2024, "gp": "Italy", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5793,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autodromo Nazionale Monza (Monza)
    "az-2016": {
        "year": 2024, "gp": "Azerbaijan", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 6003,
        "start_finish_verified": False, "direction_verified": False,
    },  # Baku City Circuit (Baku)
    "sg-2008": {
        "year": 2024, "gp": "Singapore", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4928,
        "start_finish_verified": False, "direction_verified": False,
    },  # Marina Bay Street Circuit (Singapore)
    "us-2012": {
        "year": 2024, "gp": "United States", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5514,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuit of the Americas (Austin)
    "mx-1962": {
        "year": 2024, "gp": "Mexico", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4304,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autódromo Hermanos Rodríguez (Mexico City)
    "br-1940": {
        "year": 2024, "gp": "São Paulo", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4309,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autódromo José Carlos Pace - Interlagos (São Paulo)
    "us-2023": {
        "year": 2024, "gp": "Las Vegas", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 6201,
        "start_finish_verified": False, "direction_verified": False,
    },  # Las Vegas Street Circuit (Las Vegas)
    "qa-2004": {
        "year": 2024, "gp": "Qatar", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5380,
        "start_finish_verified": False, "direction_verified": False,
    },  # Losail International Circuit (Lusail)
    "ae-2009": {
        "year": 2024, "gp": "Abu Dhabi", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5281,
        "start_finish_verified": False, "direction_verified": False,
    },  # Yas Marina Circuit (Abu Dhabi)

    # ─── Circuits with FastF1 data (not in 2024 calendar) ────────────
    "de-1927": {
        "year": 2020, "gp": "Eifel", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5148,
        "start_finish_verified": False, "direction_verified": False,
    },  # Nürburgring (Nürburg) — Eifel GP 2020
    "de-1932": {
        "year": 2019, "gp": "Germany", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4574,
        "start_finish_verified": False, "direction_verified": False,
    },  # Hockenheimring (Hockenheim) — German GP 2019
    "fr-1969": {
        "year": 2022, "gp": "France", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5842,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuit Paul Ricard (Le Castellet) — French GP 2018-2022
    "it-1914": {
        "year": 2020, "gp": "Tuscany", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5245,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autodromo Internazionale del Mugello — Tuscan GP 2020
    "pt-2008": {
        "year": 2021, "gp": "Portugal", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4653,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autódromo Internacional do Algarve (Portimão) — Portuguese GP 2020-2021
    "ru-2014": {
        "year": 2021, "gp": "Russia", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5848,
        "start_finish_verified": False, "direction_verified": False,
    },  # Sochi Autodrom (Sochi) — Russian GP 2018-2021
    "tr-2005": {
        "year": 2021, "gp": "Turkey", "session_name": "Q", "driver": "VER",
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5338,
        "start_finish_verified": False, "direction_verified": False,
    },  # Intercity Istanbul Park (Istanbul) — Turkish GP 2020-2021

    # ─── Circuits WITHOUT FastF1 data (manual split candidates) ───────
    # These circuits were last in F1 before 2018 or have never hosted F1.
    # gp=None signals that no FastF1 session is available.
    "ar-1952": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4322,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autódromo Oscar y Juan Gálvez (Buenos Aires) — last F1 1998
    "br-1977": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5031,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autódromo Internacional Nelson Piquet (Jacarepaguá) — last F1 2012 (demolished)
    "es-2026": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5474,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuito de Madring (Madrid) — future circuit, not yet raced
    "fr-1960": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4412,
        "start_finish_verified": False, "direction_verified": False,
    },  # Circuit de Nevers Magny-Cours — last F1 2008
    "my-1999": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5543,
        "start_finish_verified": False, "direction_verified": False,
    },  # Sepang International Circuit (Sepang) — last F1 2017
    "pt-1972": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4349,
        "start_finish_verified": False, "direction_verified": False,
    },  # Autódromo do Estoril (Estoril) — last F1 1996
    "us-1909": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4192,
        "start_finish_verified": False, "direction_verified": False,
    },  # Indianapolis Motor Speedway — last F1 2007
    "us-1956": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 5430,
        "start_finish_verified": False, "direction_verified": False,
    },  # Watkins Glen International — last F1 1980
    "za-1961": {
        "year": None, "gp": None, "session_name": None, "driver": None,
        "start_finish_s": 0, "direction_sign": 1, "lap_length_meters": 4529,
        "start_finish_verified": False, "direction_verified": False,
    },  # Kyalami Grand Prix Circuit (Johannesburg) — last F1 1993
}


if __name__ == "__main__":
    fastf1_only = "--fastf1-only" in sys.argv
    manual_only = "--manual-only" in sys.argv

    # Filter out flag arguments
    circuit_args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if circuit_args:
        # Generate specific circuit(s)
        for circuit_id in circuit_args:
            if circuit_id not in CIRCUITS:
                print(f"Unknown circuit: {circuit_id}")
                print(f"Available: {', '.join(sorted(CIRCUITS.keys()))}")
                sys.exit(1)
            cfg = CIRCUITS[circuit_id]
            if cfg["gp"] is None:
                generate_manual_sector_splits(
                    circuit_id=circuit_id,
                    start_finish_s=cfg["start_finish_s"],
                    direction_sign=cfg["direction_sign"],
                    lap_length_meters=cfg["lap_length_meters"],
                    start_finish_verified=cfg.get("start_finish_verified", False),
                    direction_verified=cfg.get("direction_verified", False),
                )
            else:
                generate_sector_splits(circuit_id=circuit_id, **cfg)
    else:
        # Generate all defined circuits
        for circuit_id, cfg in sorted(CIRCUITS.items()):
            is_manual = cfg["gp"] is None
            if fastf1_only and is_manual:
                continue
            if manual_only and not is_manual:
                continue

            print(f"\n{'='*60}")
            print(f"Generating: {circuit_id} ({'manual' if is_manual else 'fastf1'})")
            print(f"{'='*60}")

            if is_manual:
                generate_manual_sector_splits(
                    circuit_id=circuit_id,
                    start_finish_s=cfg["start_finish_s"],
                    direction_sign=cfg["direction_sign"],
                    lap_length_meters=cfg["lap_length_meters"],
                    start_finish_verified=cfg.get("start_finish_verified", False),
                    direction_verified=cfg.get("direction_verified", False),
                )
            else:
                try:
                    generate_sector_splits(circuit_id=circuit_id, **cfg)
                except Exception as e:
                    print(f"ERROR generating {circuit_id}: {e}")
                    print("Skipping...")
                    continue
