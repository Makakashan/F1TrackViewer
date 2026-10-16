"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useTrackEditor } from "@/lib/track/track-editor-store";
import { halfWidthAt, type HalfWidth } from "@/lib/track/track-geometry";
import type { TrackOverridePoint } from "@/lib/track/track-overrides";

/** The colours the editor panel uses for the +side and the −side. */
export const EDITOR_SIDE_COLORS = { plus: "#f59e0b", minus: "#3b82f6" } as const;

const POLE_HEIGHT_M = 6;
const UP = new THREE.Vector3(0, 1, 0);

export interface TrackEditorMarkersProps {
  curve: THREE.CatmullRomCurve3;
  halfWidth: HalfWidth;
  raise: number;
  points: TrackOverridePoint[];
}

/** A pole on the centreline for every editor point, and a post on each road edge in its side's colour. */
export default function TrackEditorMarkers({ curve, halfWidth, raise, points }: TrackEditorMarkersProps) {
  const invalidate = useThree((state) => state.invalidate);
  const visible = useTrackEditor((s) => s.markersVisible);
  const selectedId = useTrackEditor((s) => s.selectedId);
  const select = useTrackEditor((s) => s.select);

  const placed = useMemo(
    () =>
      points.map((point) => {
        const s = ((point.s % 1) + 1) % 1;
        const centre = curve.getPointAt(s);
        const across = new THREE.Vector3().crossVectors(curve.getTangentAt(s), UP).normalize();
        const edge = halfWidthAt(halfWidth, s);
        const y = centre.y + raise;
        return {
          point,
          centre: [centre.x, y, centre.z] as const,
          plus: [centre.x + across.x * edge, y, centre.z + across.z * edge] as const,
          minus: [centre.x - across.x * edge, y, centre.z - across.z * edge] as const,
        };
      }),
    [points, curve, halfWidth, raise],
  );

  // Poles come and go between frames, and the loop only draws on demand.
  useEffect(() => {
    invalidate();
  }, [visible, selectedId, placed, invalidate]);

  if (!visible) return null;

  return (
    <group>
      {placed.map(({ point, centre, plus, minus }) => {
        const selected = point.id === selectedId;
        const radius = selected ? 0.6 : 0.35;
        return (
          <group key={point.id}>
            <mesh
              position={[centre[0], centre[1] + POLE_HEIGHT_M / 2, centre[2]]}
              onClick={(event) => {
                event.stopPropagation();
                select(point.id);
              }}
            >
              <cylinderGeometry args={[radius, radius, POLE_HEIGHT_M, 8]} />
              <meshBasicMaterial color={selected ? "#e10600" : "#ffffff"} toneMapped={false} />
            </mesh>
            <mesh position={[plus[0], plus[1] + 1, plus[2]]}>
              <boxGeometry args={[0.7, 2, 0.7]} />
              <meshBasicMaterial color={EDITOR_SIDE_COLORS.plus} toneMapped={false} />
            </mesh>
            <mesh position={[minus[0], minus[1] + 1, minus[2]]}>
              <boxGeometry args={[0.7, 2, 0.7]} />
              <meshBasicMaterial color={EDITOR_SIDE_COLORS.minus} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
