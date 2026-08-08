"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { GridSlot } from "@/lib/start-grid";
import type { PoseAt } from "@/components/three/start-grid-cars";
import type { RaceController } from "@/hooks/use-race-simulation";
import { interpolateCarPose } from "@/lib/race-sim";

export interface RaceCameraRigProps {
  slots: GridSlot[];
  /** Index into `slots` — which car the camera is on. */
  focusIndex: number;
  raceSim?: RaceController | null;
  poseAt?: PoseAt;
  /** Whether the rig owns the camera. The HUD owns this state, not the rig. */
  follow?: boolean;
  /** The user took the camera — a drag, or a movement key. */
  onDetach?: () => void;
}

/** How far ahead of the car the camera sits on the grid, and how high. */
const DISTANCE_M = 13;
const HEIGHT_M = 4.2;
/** Sideways offset, for a three-quarter view rather than a head-on one. */
const LATERAL_M = 5;
/** Aim a little above the floor — the car's body, not the tarmac under it. */
const TARGET_HEIGHT_M = 0.9;

/**
 * How the follow target catches the car.
 *
 * Two filters rather than one. The velocity filter smooths the car's own
 * step-to-step speed, which is piecewise constant because the simulation runs
 * at a fixed rate; the error filter closes whatever distance is left. Feeding
 * the velocity forward is what keeps the lag at zero — a plain error filter
 * trails by speed divided by rate, which is meters at racing speed, and
 * tracking the interpolated pose exactly instead hands every step boundary
 * straight to the camera as a jolt.
 */
const VELOCITY_RATE = 9;
const ERROR_RATE = 7;

/** Free-camera pan, as a share of the camera-to-target distance per second. */
const PAN_RATE = 1.4;
const PAN_MIN_M_S = 25;
/** Free-camera yaw around the target, in radians per second. */
const YAW_RATE = 1.6;

const UP = new THREE.Vector3(0, 1, 0);
const NOSE = new THREE.Vector3(0, 0, 1);

/** Keys that take the camera off the car and into free flight. */
const PAN_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
/** Keys that spin the view in place — they work in both modes. */
const YAW_KEYS = new Set(["KeyQ", "KeyE"]);

type OrbitLike = {
  target: THREE.Vector3;
  update: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable
  );
}

/**
 * The camera in race mode: glued to a car when `follow` is on, WASD flight
 * when it is off.
 *
 * Following does not mean framed: the rig owns *where the camera looks* (the
 * car) and the user owns *from where* — dragging orbits around the moving car
 * without breaking the follow, exactly like orbiting a parked one. Only WASD
 * or the HUD button let go of the car; the rig itself never decides its mode,
 * it reports via `onDetach` and the HUD flips the state.
 */
export default function RaceCameraRig({
  slots,
  focusIndex,
  raceSim,
  poseAt,
  follow = true,
  onDetach,
}: RaceCameraRigProps) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as OrbitLike | null;
  const invalidate = useThree((state) => state.invalidate);
  const lastKey = useRef<string | null>(null);
  const pressed = useRef<Set<string>>(new Set());
  // Set when the rig owes the camera a framing: a new car, follow switched
  // back on, or the race starting.
  const needsFraming = useRef(true);
  // Where the camera sits in the followed car's own frame — across, up, ahead.
  // Kept so that switching drivers hands the new car the view the user built
  // around the old one instead of throwing it away for the default.
  const localOffset = useRef<THREE.Vector3 | null>(null);
  const knownSlots = useRef<GridSlot[] | null>(null);
  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    forward: new THREE.Vector3(),
    across: new THREE.Vector3(),
    desired: new THREE.Vector3(),
    target: new THREE.Vector3(),
    move: new THREE.Vector3(),
    offset: new THREE.Vector3(),
    lastTarget: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    step: new THREE.Vector3(),
    local: new THREE.Vector3(),
  });

  /** Camera position for a car frame, from the stored offset or the default. */
  function placeCamera(
    origin: THREE.Vector3,
    forward: THREE.Vector3,
    across: THREE.Vector3,
    out: THREE.Vector3,
  ) {
    const offset = localOffset.current;
    const ox = offset ? offset.x : LATERAL_M;
    const oy = offset ? offset.y : HEIGHT_M;
    const oz = offset ? offset.z : DISTANCE_M;
    out
      .copy(origin)
      .addScaledVector(across, ox)
      .addScaledVector(UP, oy)
      .addScaledVector(forward, oz);
  }

  /** The reverse: remember where the user has left the camera. */
  function rememberCamera(
    origin: THREE.Vector3,
    forward: THREE.Vector3,
    across: THREE.Vector3,
  ) {
    const s = scratch.current;
    s.local.copy(camera.position).sub(origin);
    localOffset.current = (localOffset.current ?? new THREE.Vector3()).set(
      s.local.dot(across),
      s.local.dot(UP),
      s.local.dot(forward),
    );
  }

  // Movement keys are held, not tapped, so they are polled per frame; the
  // listeners only maintain the set. Keydown also kicks a frame — before the
  // race the loop is on demand, and a key press must not wait for one.
  // Dragging deliberately does not detach: orbiting the followed car is how
  // the user picks their angle, and the rig keeps that angle while it tracks.
  useEffect(() => {
    const keys = pressed.current;
    const onKeyDown = (event: KeyboardEvent) => {
      const pan = PAN_KEYS.has(event.code);
      const yaw = YAW_KEYS.has(event.code);
      if ((!pan && !yaw) || isTypingTarget(event.target)) return;
      keys.add(event.code);
      if (pan) onDetach?.();
      invalidate();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(event.code);
    };
    const onBlur = () => keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      keys.clear();
    };
  }, [invalidate, onDetach]);

  const racing =
    !!raceSim && raceSim.phase !== "standby" && raceSim.phase !== "lights";

  useEffect(() => {
    if (follow) needsFraming.current = true;
  }, [follow, focusIndex, racing]);

  // Parked framing on the grid. Skipped while racing and while the user has
  // the camera — it is a default, not an override.
  useEffect(() => {
    const slot = slots[focusIndex];
    if (!slot || !controls || racing || !follow) return;

    // Re-framing on every render would undo the user's own orbit; key on the
    // car and its position so a circuit change reframes but a re-render does
    // not.
    const key = `${focusIndex}:${slot.position.toArray().join(",")}`;
    if (lastKey.current === key) return;
    lastKey.current = key;

    // A different circuit is a different scene, and the view built around the
    // last one means nothing on it.
    if (knownSlots.current !== slots) {
      knownSlots.current = slots;
      localOffset.current = null;
    }

    const target = slot.position.clone().addScaledVector(UP, TARGET_HEIGHT_M);

    // Offset toward the centerline rather than the verge: the gantry posts and
    // the barriers live at the edges, and a camera set down beside one frames
    // the post instead of the car.
    const across = slot.across.clone().multiplyScalar(-slot.side);
    placeCamera(slot.position, slot.forward, across, camera.position);
    camera.lookAt(target);

    controls.target.copy(target);
    controls.update();
    invalidate();
  }, [slots, focusIndex, camera, controls, invalidate, racing, follow]);

  useFrame((_, delta) => {
    if (!controls) return;
    const s = scratch.current;
    const keys = pressed.current;

    // Q/E spin the view around whatever it is looking at, in either mode.
    const yaw = (keys.has("KeyQ") ? 1 : 0) - (keys.has("KeyE") ? 1 : 0);
    if (yaw !== 0) {
      s.offset.copy(camera.position).sub(controls.target);
      s.offset.applyAxisAngle(UP, yaw * YAW_RATE * delta);
      camera.position.copy(controls.target).add(s.offset);
      controls.update();
      invalidate();
    }

    // Free flight: WASD pans in the camera's ground plane.
    if (!follow && keys.size > 0) {
      camera.getWorldDirection(s.forward);
      s.forward.y = 0;
      if (s.forward.lengthSq() < 1e-6) s.forward.set(0, 0, -1);
      s.forward.normalize();
      s.across.crossVectors(s.forward, UP).normalize();

      s.move.set(0, 0, 0);
      if (keys.has("KeyW")) s.move.add(s.forward);
      if (keys.has("KeyS")) s.move.sub(s.forward);
      if (keys.has("KeyD")) s.move.add(s.across);
      if (keys.has("KeyA")) s.move.sub(s.across);
      if (s.move.lengthSq() > 0) {
        const span = Math.max(
          PAN_MIN_M_S,
          camera.position.distanceTo(controls.target) * PAN_RATE,
        );
        s.move.normalize().multiplyScalar(span * delta);
        camera.position.add(s.move);
        controls.target.add(s.move);
      }

      controls.update();
      // Holding a key must keep frames coming when the loop is on demand.
      invalidate();
      return;
    }

    // Parked on the grid, the car is not moving, so there is nothing to track
    // — only the angle the user is orbiting to, which is worth keeping.
    if (follow && !racing) {
      const slot = slots[focusIndex];
      if (slot) {
        s.across.copy(slot.across).multiplyScalar(-slot.side);
        rememberCamera(slot.position, slot.forward, s.across);
      }
      return;
    }

    // Follow. The target rides the car; the camera rides the target at
    // whatever offset the user's orbiting has left it — moving both by the
    // same delta is what preserves the chosen angle while tracking.
    if (!follow || !racing) return;
    if (!raceSim || !poseAt) return;
    const state = raceSim.stateRef.current;
    const car = state?.cars[focusIndex];
    if (!car) return;

    const pose = interpolateCarPose(car, raceSim.alphaRef.current);
    poseAt(pose.s, pose.lateral, s.position, s.quaternion);
    s.target.copy(s.position).addScaledVector(UP, TARGET_HEIGHT_M);

    s.forward.copy(NOSE).applyQuaternion(s.quaternion).normalize();
    s.across.crossVectors(s.forward, UP).normalize();

    if (needsFraming.current) {
      // Whatever view the user last had on a car — the default only until they
      // have moved the camera themselves.
      needsFraming.current = false;
      placeCamera(s.position, s.forward, s.across, camera.position);
      controls.target.copy(s.target);
      camera.lookAt(s.target);
      controls.update();
      s.lastTarget.copy(s.target);
      s.velocity.set(0, 0, 0);
      return;
    }

    // Velocity feed-forward plus error correction: the camera runs at the
    // car's own speed and only filters the difference, so it neither trails
    // the car nor passes its step-rate jitter on to the whole view.
    if (delta > 1e-4) {
      s.step.copy(s.target).sub(s.lastTarget).divideScalar(delta);
      s.velocity.lerp(s.step, 1 - Math.exp(-VELOCITY_RATE * delta));
    }
    s.lastTarget.copy(s.target);

    s.move.copy(s.velocity).multiplyScalar(delta);
    s.offset
      .copy(s.target)
      .sub(controls.target)
      .sub(s.move)
      .multiplyScalar(1 - Math.exp(-ERROR_RATE * delta));
    s.move.add(s.offset);

    controls.target.add(s.move);
    camera.position.add(s.move);
    controls.update();

    // Read back rather than track the drag: the user orbits through
    // OrbitControls, which moves the camera behind the rig's back.
    rememberCamera(s.position, s.forward, s.across);
  });

  return null;
}
