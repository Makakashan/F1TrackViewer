"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

interface StudioStageProps {
  radius: number;
  floorY: number;
  hasEnvironment: boolean;
  resolvedTheme: "light" | "dark";
}

function makeStageTexture(hasEnvironment: boolean, isDark: boolean) {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const cx = size / 2;
  const cy = size / 2;
  const base = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.72);
  if (isDark) {
    base.addColorStop(0, hasEnvironment ? "#090C12" : "#171A20");
    base.addColorStop(hasEnvironment ? 0.24 : 0.18, hasEnvironment ? "#070A0F" : "#101319");
    base.addColorStop(0.58, hasEnvironment ? "#040609" : "#07090D");
    base.addColorStop(1, "#020306");
  } else {
    base.addColorStop(0, "#EEF1F5");
    base.addColorStop(0.3, "#E2E7EE");
    base.addColorStop(0.65, "#D5DCE5");
    base.addColorStop(1, "#C8D0DB");
  }
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const redGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.36);
  if (isDark) {
    redGlow.addColorStop(0, hasEnvironment ? "rgba(225, 6, 0, 0.025)" : "rgba(225, 6, 0, 0.1)");
    redGlow.addColorStop(0.38, hasEnvironment ? "rgba(225, 6, 0, 0.008)" : "rgba(225, 6, 0, 0.032)");
  } else {
    redGlow.addColorStop(0, hasEnvironment ? "rgba(225, 6, 0, 0.018)" : "rgba(225, 6, 0, 0.06)");
    redGlow.addColorStop(0.38, hasEnvironment ? "rgba(225, 6, 0, 0.006)" : "rgba(225, 6, 0, 0.02)");
  }
  redGlow.addColorStop(1, "rgba(225, 6, 0, 0)");
  ctx.fillStyle = redGlow;
  ctx.fillRect(0, 0, size, size);

  if (!isDark) {
    const warmRim = ctx.createRadialGradient(cx, cy, size * 0.24, cx, cy, size * 0.74);
    warmRim.addColorStop(0, "rgba(160, 170, 185, 0)");
    warmRim.addColorStop(0.62, "rgba(160, 170, 185, 0.03)");
    warmRim.addColorStop(1, "rgba(160, 170, 185, 0)");
    ctx.fillStyle = warmRim;
    ctx.fillRect(0, 0, size, size);
  } else {
    const coolRim = ctx.createRadialGradient(cx, cy, size * 0.24, cx, cy, size * 0.74);
    coolRim.addColorStop(0, "rgba(99, 121, 170, 0)");
    coolRim.addColorStop(0.62, "rgba(99, 121, 170, 0.022)");
    coolRim.addColorStop(1, "rgba(99, 121, 170, 0)");
    ctx.fillStyle = coolRim;
    ctx.fillRect(0, 0, size, size);
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = isDark
    ? (hasEnvironment ? "rgba(198, 209, 232, 0.014)" : "rgba(198, 209, 232, 0.026)")
    : "rgba(140, 152, 168, 0.05)";
  ctx.lineWidth = 1;
  for (let r = 180; r < size * 0.49; r += hasEnvironment ? 180 : 116) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (!hasEnvironment) {
    ctx.strokeStyle = isDark ? "rgba(198, 209, 232, 0.007)" : "rgba(140, 152, 168, 0.03)";
    const step = 96;
    for (let p = -size / 2; p <= size / 2; p += step) {
      ctx.beginPath();
      ctx.moveTo(p, -size / 2);
      ctx.lineTo(p, size / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-size / 2, p);
      ctx.lineTo(size / 2, p);
      ctx.stroke();
    }
  }
  ctx.restore();

  const vignette = ctx.createRadialGradient(cx, cy, size * 0.34, cx, cy, size * 0.72);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(0.72, isDark ? "rgba(0, 0, 0, 0.14)" : "rgba(120, 130, 145, 0.08)");
  vignette.addColorStop(1, isDark ? "rgba(0, 0, 0, 0.7)" : "rgba(120, 130, 145, 0.22)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function makeGlowTexture(color: string, innerAlpha: number, outerAlpha = 0) {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, color.replace("<alpha>", String(innerAlpha)));
  gradient.addColorStop(0.32, color.replace("<alpha>", String(innerAlpha * 0.44)));
  gradient.addColorStop(0.72, color.replace("<alpha>", String(innerAlpha * 0.08)));
  gradient.addColorStop(1, color.replace("<alpha>", String(outerAlpha)));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export default function StudioStage({
  radius,
  floorY,
  hasEnvironment,
  resolvedTheme,
}: StudioStageProps) {
  const isDark = resolvedTheme === "dark";
  const floorSize = Math.max(radius * (hasEnvironment ? 4.0 : 6.2), 1200);
  const pedestalSize = Math.max(radius * (hasEnvironment ? 2.0 : 2.1), 360);
  const stageTexture = useMemo(
    () => makeStageTexture(hasEnvironment, isDark),
    [hasEnvironment, isDark],
  );
  const redGlowTexture = useMemo(
    () => makeGlowTexture("rgba(225, 6, 0, <alpha>)", hasEnvironment ? 0.025 : 0.13),
    [hasEnvironment],
  );
  const shadowTexture = useMemo(
    () => makeGlowTexture("rgba(0, 0, 0, <alpha>)", hasEnvironment ? (isDark ? 0.2 : 0.1) : 0.28),
    [hasEnvironment, isDark],
  );

  useEffect(() => {
    return () => {
      stageTexture?.dispose();
      redGlowTexture?.dispose();
      shadowTexture?.dispose();
    };
  }, [stageTexture, redGlowTexture, shadowTexture]);

  const stageOpacity = isDark ? 1 : 0.92;

  return (
    <group renderOrder={-20}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, floorY, 0]}>
        <planeGeometry args={[floorSize, floorSize, 1, 1]} />
        <meshBasicMaterial
          map={stageTexture}
          color="#ffffff"
          transparent
          opacity={stageOpacity}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Pedestal shadow + red glow are only for the non-environment
          pedestal look. In environment mode the DioramaBase provides
          the platform and these decorative planes would be visible
          through the terrain edge gap as a "rectangular dome". */}
      {!hasEnvironment && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, floorY + 0.03, 0]}>
            <planeGeometry args={[pedestalSize, pedestalSize, 1, 1]} />
            <meshBasicMaterial
              map={shadowTexture}
              transparent
              opacity={0.72}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>

          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, floorY + 0.05, 0]}>
            <planeGeometry args={[pedestalSize * 1.22, pedestalSize * 1.22, 1, 1]} />
            <meshBasicMaterial
              map={redGlowTexture}
              transparent
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </>
      )}
    </group>
  );
}
