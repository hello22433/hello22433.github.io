#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""지하철 혼잡도 예측 데이터를 미리 계산해서 정적 JSON으로 떨어뜨린다.

GitHub Pages는 서버가 없으므로 실시간 계산 대신 "노선 × 방향 × 요일 × 30분 단위
시간대"의 예상 재차율(혼잡도)과 하차율을 사전 계산해 두고, 브라우저는 조회만 한다.

모델 요약
---------
1. 역마다 (주거/업무/상권) 성격과 규모 계수를 부여한다. (stations.PROFILE)
2. 시간대별로 통행 목적 비중이 바뀐다.
   - 오전 첨두: 출발지는 주거지, 도착지는 업무지구
   - 오후 첨두: 그 반대
   - 그 외: 상권/여가 비중 상승
3. 기종점 통행량 행렬 M[i][j] ∝ O_i · D_j · w(거리) 를 만든다.
   (w 는 지하철 통행거리 분포를 흉내낸 감마형 커널)
4. 구간별 재차 인원 = 그 구간을 지나는 모든 통행의 합. (차분 배열로 계산)
5. 재차 인원 / (배차 × 량수 × 정원 160명) → 재차율(%).
6. 노선별 최고 재차율이 공개 통계 수준(LINES[*]["peak"])이 되도록 스케일 보정.

주의: 실측 승하차 통계가 아니라 역세권 성격 기반 추정 모델이다.
서울열린데이터광장의 시간대별 승하차 인원 CSV가 있으면 ``load_real_od()``
자리에 끼워 넣어 O/D 가중치를 실측값으로 대체할 수 있다.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone, timedelta

from stations import LINES, PROFILE, DEFAULT_PROFILE, ALIAS

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "subway",
    "data",
)

# 05:00 ~ 24:30, 30분 간격 40개 구간
SLOT_START_MIN = 5 * 60
SLOT_STEP = 30
SLOT_COUNT = 40

CAPACITY_PER_CAR = 160  # 재차율 100% 기준 1량 정원(명)
SEATS_PER_CAR = 54      # 1량 좌석 수(대략)

DAYTYPES = ("wd", "sa", "su")  # 평일 / 토요일 / 일요일·공휴일


# ---------------------------------------------------------------------------
# 시간대 프로파일
# ---------------------------------------------------------------------------

def slot_minutes(s: int) -> int:
    return SLOT_START_MIN + s * SLOT_STEP


def slot_hour(s: int) -> float:
    return slot_minutes(s) / 60.0


# 전체 통행량의 시간대별 상대 크기.
# 평일 오전 첨두 한 시간을 1.0 으로 두고, 각 시간대의 수송 수요를 상대값으로 적는다.
# 주말 곡선은 하루 총량이 평일 대비 토요일 약 70%, 일요일 약 55% 가 되도록
# WEEKEND_SCALE 로 눌러 준다.
_WD = [
    0.08, 0.12, 0.22, 0.35, 0.62, 0.88, 1.00, 0.92, 0.66, 0.45,
    0.36, 0.33, 0.34, 0.38, 0.44, 0.46, 0.42, 0.38, 0.37, 0.38,
    0.40, 0.43, 0.47, 0.52, 0.62, 0.78, 0.95, 0.93, 0.74, 0.58,
    0.46, 0.40, 0.38, 0.36, 0.33, 0.28, 0.21, 0.14, 0.08, 0.04,
]
_SA = [
    0.05, 0.07, 0.11, 0.15, 0.21, 0.27, 0.34, 0.40, 0.46, 0.52,
    0.57, 0.61, 0.64, 0.66, 0.68, 0.69, 0.69, 0.68, 0.68, 0.68,
    0.69, 0.70, 0.71, 0.72, 0.72, 0.71, 0.69, 0.66, 0.61, 0.56,
    0.51, 0.46, 0.42, 0.38, 0.34, 0.29, 0.23, 0.16, 0.10, 0.05,
]
_SU = [
    0.04, 0.05, 0.08, 0.11, 0.15, 0.19, 0.24, 0.29, 0.35, 0.41,
    0.46, 0.50, 0.53, 0.55, 0.57, 0.58, 0.58, 0.57, 0.57, 0.57,
    0.58, 0.59, 0.60, 0.61, 0.61, 0.60, 0.58, 0.55, 0.50, 0.45,
    0.40, 0.35, 0.31, 0.27, 0.23, 0.19, 0.15, 0.10, 0.06, 0.03,
]


def _scaled(curve, share):
    """하루 총량이 평일 대비 share 배가 되도록 곡선을 조정한다."""
    k = (sum(_WD) * share) / sum(curve)
    return [v * k for v in curve]


DEMAND = {
    "wd": _WD,
    "sa": _scaled(_SA, 0.70),
    "su": _scaled(_SU, 0.55),
}


# 시간당 열차 횟수(배차). 혼잡도는 수요/공급이라 배차 패턴이 중요하다.
def trains_per_hour(daytype: str, s: int) -> float:
    h = slot_hour(s)
    if daytype == "wd":
        if 7.0 <= h < 9.0:
            return 30.0
        if 18.0 <= h < 19.5:
            return 26.0
        if 6.0 <= h < 7.0 or 9.0 <= h < 10.0 or 17.0 <= h < 18.0 or 19.5 <= h < 20.5:
            return 18.0
        if h < 6.0:
            return 8.0
        if h >= 22.5:
            return 10.0
        return 13.0
    if h < 6.5:
        return 7.0
    if h >= 22.5:
        return 9.0
    return 12.0


def _gauss(x: float, mu: float, sigma: float) -> float:
    return math.exp(-0.5 * ((x - mu) / sigma) ** 2)


def purpose_mix(daytype: str, s: int):
    """(오전 통근, 오후 퇴근, 여가/기타) 비중을 돌려준다. 합은 1."""
    h = slot_hour(s)
    if daytype == "wd":
        am = _gauss(h, 8.05, 1.05)
        pm = _gauss(h, 18.4, 1.35) * 0.95
    else:
        am = _gauss(h, 9.5, 1.6) * 0.18
        pm = _gauss(h, 18.5, 2.0) * 0.20
    base = 0.30 + 0.55 * _gauss(h, 15.0, 4.5)
    total = am + pm + base
    return am / total, pm / total, base / total


# 통행 거리(정거장 수) 분포 커널.
# 첨두 시간대의 통근 통행은 길고(도심까지 쭉 간다), 낮·주말의 생활 통행은 짧다.
# 통행이 길수록 같은 간선 구간에 여러 통행이 겹쳐 쌓이므로, 이 차이가
# "출퇴근 시간에만 유독 터지는" 패턴을 만든다.
_KERNEL_CACHE = {}


def kernel(commute_share: float, size: int):
    decay = 6.5 + 6.5 * commute_share
    key = (round(decay, 2), size)
    k = _KERNEL_CACHE.get(key)
    if k is None:
        k = [0.0] + [(d ** 0.75) * math.exp(-d / decay) for d in range(1, size + 1)]
        _KERNEL_CACHE[key] = k
    return k


# ---------------------------------------------------------------------------
# 역 프로파일
# ---------------------------------------------------------------------------

def canonical(name: str) -> str:
    return ALIAS.get(name, name)


def profile(name: str, transfers: int = 0):
    res, off, com, scale = PROFILE.get(name, DEFAULT_PROFILE)
    t = res + off + com
    # 환승역은 다른 노선에서 갈아타는 승객이 그 역의 승차로 잡히므로 규모를 키운다.
    scale *= 1.0 + 0.40 * transfers
    return res / t, off / t, com / t, scale


def build_transfer_map():
    """같은 역 이름이 여러 노선에 나오면 환승역으로 본다."""
    m = {}
    for line in LINES:
        for run in line["runs"]:
            for st in run["stations"]:
                m.setdefault(canonical(st), set()).add(line["id"])
    return m


# ---------------------------------------------------------------------------
# 시뮬레이션
# ---------------------------------------------------------------------------

def section_loads(names, is_loop, daytype, s, transfers=None):
    """구간별 재차 인원(상대값)과 역별 하차 인원(상대값)을 계산한다.

    반환: (load[i] = 역 i를 출발한 직후 열차에 탄 인원, alight[i] = 역 i 하차 인원)
    """
    n = len(names)
    am, pm, leisure = purpose_mix(daytype, s)
    demand = DEMAND[daytype][s]
    _KERNEL = kernel(am + pm, n)

    transfers = transfers or [0] * n
    origin = []
    dest = []
    for idx, nm in enumerate(names):
        res, off, com, scale = profile(nm, transfers[idx])
        o = scale * (am * res + pm * off + leisure * (0.62 * com + 0.24 * res + 0.14 * off))
        d = scale * (am * off + pm * res + leisure * (0.62 * com + 0.14 * res + 0.24 * off))
        origin.append(o)
        dest.append(d)

    diff = [0.0] * (n + 1)
    alight = [0.0] * n

    # 순환선에서는 승객이 두 방향 중 가까운 쪽을 타므로 최대 반 바퀴까지만 본다.
    max_d = (n // 2) if is_loop else (n - 1)

    # 발생 제약(singly-constrained) 중력모형: 역 i의 승차량은 O_i 로 고정하고
    # 그 승객을 하류 역들에 D_j·K(거리) 비율로 배분한다. 이렇게 해야 지선처럼
    # 짧은 계통도 "역 규모에 비례하는" 승차량을 갖는다.
    for i in range(n):
        oi = origin[i]
        if oi <= 0:
            continue
        targets = []
        denom = 0.0
        for d in range(1, max_d + 1):
            j = i + d
            if j >= n:
                if not is_loop:
                    break
                j -= n
            w = dest[j] * _KERNEL[d]
            if w <= 0:
                continue
            targets.append((j, w))
            denom += w
        if denom <= 0:
            continue
        for j, w in targets:
            m = oi * w / denom
            alight[j] += m
            if j > i:
                diff[i] += m
                diff[j] -= m
            else:  # 순환선에서 한 바퀴 감김
                diff[i] += m
                diff[n] -= m
                diff[0] += m
                diff[j] -= m

    # 시간대 계수만 곱한다. 노선 전체 크기는 뒤에서 최고 혼잡도 기준으로 보정된다.
    k = demand

    load = [0.0] * n
    acc = 0.0
    for i in range(n):
        acc += diff[i]
        load[i] = max(0.0, acc * k)
    alight = [a * k for a in alight]
    return load, alight


def build_line(line, transfer_map):
    cars = line["cars"]
    express = set(line.get("express", []))
    is_loop = line.get("loop", False)

    # 노선에 등장하는 모든 역(중복 제거, 첫 등장 순서 유지)
    order = []
    seen = {}
    for run in line["runs"]:
        for st in run["stations"]:
            if st not in seen:
                seen[st] = len(order)
                order.append(st)

    stations = []
    for st in order:
        others = sorted(transfer_map.get(canonical(st), set()) - {line["id"]})
        entry = {"n": st}
        if others:
            entry["t"] = others
        if st in express:
            entry["x"] = 1
        stations.append(entry)

    runs_out = []
    raw = []  # 보정 전 재차율 저장
    for run in line["runs"]:
        loop = is_loop and run is line["runs"][0]
        fwd_names = run["stations"]
        bwd_names = list(reversed(run["stations"])) if not loop else list(run["stations"])
        # 순환선 내선순환은 반대 방향으로 도는 것이므로 역순 사용
        if loop:
            bwd_names = list(reversed(run["stations"]))

        dirs = []
        for label, names in (
            (run["fwd"], fwd_names),
            (run["bwd"], bwd_names),
        ):
            seq = [seen[nm] for nm in names]
            tcount = [
                len(transfer_map.get(canonical(nm), set()) - {line["id"]}) for nm in names
            ]
            dload = {}
            dalight = {}
            for dt in DAYTYPES:
                lm = []
                am_ = []
                for s in range(SLOT_COUNT):
                    load, alight = section_loads(names, loop, dt, s, tcount)
                    tph = trains_per_hour(dt, s)
                    cap = tph * 0.5 * cars * CAPACITY_PER_CAR  # 30분간 수송력
                    lm.append([(v / cap * 100.0) if cap else 0.0 for v in load])
                    prev = [0.0] + load[:-1]
                    am_.append([
                        (alight[i] / prev[i] * 100.0) if prev[i] > 1e-9 else 0.0
                        for i in range(len(names))
                    ])
                dload[dt] = lm
                dalight[dt] = am_
            dirs.append({"label": label, "seq": seq, "_load": dload, "_alight": dalight})
            raw.append(dload)
        runs_out.append({"name": run["name"], "loop": 1 if loop else 0, "dirs": dirs})

    # --- 노선 최고 혼잡도를 공개 통계 수준에 맞춰 보정 ---
    peak = 0.0
    for dload in raw:
        for dt in DAYTYPES:
            for row in dload[dt]:
                for v in row:
                    if v > peak:
                        peak = v
    scale = (line["peak"] / peak) if peak > 0 else 0.0

    for r in runs_out:
        for d in r["dirs"]:
            load = {}
            alight = {}
            for dt in DAYTYPES:
                # [슬롯][역] → [역][슬롯] 으로 전치해서 조회를 쉽게 한다
                lm = d["_load"][dt]
                am_ = d["_alight"][dt]
                nst = len(d["seq"])
                load[dt] = [
                    [int(round(min(300.0, lm[s][i] * scale))) for s in range(SLOT_COUNT)]
                    for i in range(nst)
                ]
                alight[dt] = [
                    [int(round(min(100.0, am_[s][i]))) for s in range(SLOT_COUNT)]
                    for i in range(nst)
                ]
            d["load"] = load
            d["alight"] = alight
            del d["_load"], d["_alight"]

    return {
        "id": line["id"],
        "name": line["name"],
        "color": line["color"],
        "cars": cars,
        "cool": line.get("cool", []),
        "peak": line["peak"],
        "express": sorted(express),
        "stations": stations,
        "runs": runs_out,
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    transfer_map = build_transfer_map()

    kst = timezone(timedelta(hours=9))
    index = {
        "generated": datetime.now(kst).strftime("%Y-%m-%d %H:%M KST"),
        "slots": {"start": SLOT_START_MIN, "step": SLOT_STEP, "count": SLOT_COUNT},
        "capacityPerCar": CAPACITY_PER_CAR,
        "seatsPerCar": SEATS_PER_CAR,
        "lines": [],
    }

    for line in LINES:
        data = build_line(line, transfer_map)
        path = os.path.join(OUT_DIR, f"line-{line['id']}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(path) / 1024
        print(f"  line {line['id']:>2}  {len(data['stations']):>3} stations  {size:7.1f} KB")

        index["lines"].append({
            "id": data["id"],
            "name": data["name"],
            "color": data["color"],
            "cars": data["cars"],
            "file": f"line-{line['id']}.json",
            "stations": [s["n"] for s in data["stations"]],
        })

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    total = sum(len(l["stations"]) for l in index["lines"])
    print(f"  index.json  ({total} station entries)")


if __name__ == "__main__":
    main()
