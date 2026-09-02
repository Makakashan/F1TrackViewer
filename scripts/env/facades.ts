/**
 * What a wall looks like, and which wall it is.
 *
 * An extruded footprint is honest about where a building stands and says
 * nothing about what it is. Painting storeys as bands said "floors" and not
 * much else — a facade is a pattern of openings, and a pattern is what a
 * texture is for. So each kind of building gets a small tile: one bay wide and
 * one storey tall, repeated along the wall by the sampler, with a shop front
 * under it and a plain strip for the roof.
 *
 * Greyscale on purpose. The tile multiplies the palette's own building colour,
 * so the diorama stays the colour it is and the windows are holes in it.
 */

import { PNG } from "pngjs";

/** What a building is, as far as its walls are concerned. */
export type Facade = "tower" | "block" | "house" | "retail" | "plain";

export const FACADES: Facade[] = ["tower", "block", "house", "retail", "plain"];

/**
 * One bay across and one storey up, and a tile holds two of each.
 *
 * Four cells rather than one, each with its openings a little different: a tile
 * with one window in it repeats as a grid of identical windows, which is what a
 * city of one building looks like. Repeated, four cells read as a facade that
 * was built rather than printed.
 */
export const BAY_M = 3.4;
export const FACADE_STOREY_M = 3.1;
export const TILE_BAYS = 2;
export const TILE_STOREYS = 2;

/**
 * Which of a facade's two tiles a wall is asking for.
 *
 * A storey tile repeats both ways — across the wall by the bay and up it by the
 * floor — so a wall of any height is one quad. The ground floor is its own tile
 * and its own quad, because a shop front is not a storey repeated.
 */
export type FacadeZone = "storey" | "shop";

const CELL = 96;
const WIDTH = CELL * TILE_BAYS;
const HEIGHT = CELL * TILE_STOREYS;

/**
 * Wall, frame, glass, slab — as colours now, because glass is not grey.
 *
 * Nothing goes near black: the occlusion pass multiplies over this, and a
 * window at a third of the wall is a hole rather than a window. The glass
 * carries the sky it reflects, which is what tells it from a shadow.
 */
const WALL: Colour = [1, 1, 1];
const FRAME: Colour = [0.92, 0.92, 0.9];
const GLASS: Colour = [0.42, 0.5, 0.6];
const SLAB: Colour = [0.78, 0.78, 0.76];

type Colour = [number, number, number];

interface Plan {
  /** Window opening as a share of the bay and of the storey. */
  windowWidth: number;
  windowHeight: number;
  /** How many openings across one bay. */
  lights: number;
  /** A slab across the bottom of the storey: a balcony. */
  balcony: boolean;
  /** The shop front: how much of the ground floor is glass. */
  shopGlass: number;
}

/**
 * The openings, as a share of one bay and one storey.
 *
 * Bigger than they were: two lights of 0.36 of a 2.7 m bay is a 0.97 m window,
 * and a city of them reads as a rash of dots at any distance a whole building
 * fits the frame. One light of 0.7 on a 3.4 m bay is 2.4 m — a window somebody
 * could stand at, which is what the eye is looking for.
 */
const PLAN: Record<Facade, Plan> = {
  // A ribbon of glass, nearly the width of the bay, no balconies.
  tower: { windowWidth: 0.82, windowHeight: 0.62, lights: 1, balcony: false, shopGlass: 0.86 },
  // Somebody lives here: one window a room, a balcony to open it onto.
  block: { windowWidth: 0.62, windowHeight: 0.56, lights: 1, balcony: true, shopGlass: 0.6 },
  // A house has fewer openings and more wall between them.
  house: { windowWidth: 0.42, windowHeight: 0.48, lights: 1, balcony: false, shopGlass: 0.34 },
  // A shop is glass at the bottom and little above it.
  retail: { windowWidth: 0.4, windowHeight: 0.34, lights: 1, balcony: false, shopGlass: 0.94 },
  // A wall with a door in it somewhere: warehouses, plant rooms, car parks.
  plain: { windowWidth: 0.22, windowHeight: 0.26, lights: 1, balcony: false, shopGlass: 0.14 },
};

function fill(png: PNG, x0: number, y0: number, x1: number, y1: number, colour: Colour): void {
  const channel = colour.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255));
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(HEIGHT, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(WIDTH, Math.round(x1)); x++) {
      const at = (y * WIDTH + x) * 4;
      png.data[at] = channel[0];
      png.data[at + 1] = channel[1];
      png.data[at + 2] = channel[2];
      png.data[at + 3] = 255;
    }
  }
}

/** Repeatable per cell, so the same tile comes out of every bake. */
function jitter(cell: number, salt: number): number {
  const value = Math.sin((cell + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function storeyCell(
  png: PNG,
  plan: Plan,
  x0: number,
  y0: number,
  cell: number,
  paintBalcony: boolean,
): void {
  if (plan.balcony && paintBalcony) {
    // A slab across the bottom of the floor, which is what a balcony is from
    // the street: a line under the windows rather than a box. Not on every
    // cell — a block has a balcony where a room opens onto one.
    if (jitter(cell, 5) > 0.3) fill(png, x0, y0 + CELL * 0.84, x0 + CELL, y0 + CELL, SLAB);
  }
  const widthScale = 0.85 + 0.3 * jitter(cell, 1);
  const heightScale = 0.9 + 0.2 * jitter(cell, 2);
  const shift = (jitter(cell, 3) - 0.5) * CELL * 0.08;
  for (let light = 0; light < plan.lights; light++) {
    const centre = x0 + ((light + 0.5) / plan.lights) * CELL + shift;
    const halfWidth = (plan.windowWidth / plan.lights) * CELL * 0.5 * widthScale;
    const height = CELL * plan.windowHeight * heightScale;
    const top = y0 + CELL * 0.22;
    fill(png, centre - halfWidth - 2, top - 2, centre + halfWidth + 2, top + height + 2, FRAME);
    fill(png, centre - halfWidth, top, centre + halfWidth, top + height, GLASS);
  }
}

function shopCell(png: PNG, plan: Plan, x0: number, y0: number, cell: number): void {
  // Along a street the shops are not all the same width, and one unit in three
  // is a doorway or a blank wall rather than a window.
  const shut = jitter(cell, 7) > 0.72;
  const glassHalf = ((shut ? 0.18 : plan.shopGlass) * CELL * (0.8 + 0.4 * jitter(cell, 4))) / 2;
  const centre = x0 + CELL / 2;
  fill(png, centre - glassHalf - 2, y0 + CELL * 0.16, centre + glassHalf + 2, y0 + CELL * 0.94, FRAME);
  fill(png, centre - glassHalf, y0 + CELL * 0.22, centre + glassHalf, y0 + CELL * 0.88, GLASS);
}

/**
 * One tile of one kind of building, as PNG bytes.
 *
 * `paintBalcony` is false where the belt builds them instead: a painted slab
 * under a built one is the same balcony twice.
 */
export function facadeTexture(facade: Facade, zone: FacadeZone, paintBalcony = true): Buffer {
  const plan = PLAN[facade];
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  fill(png, 0, 0, WIDTH, HEIGHT, WALL);

  let cell = 0;
  for (let row = 0; row < TILE_STOREYS; row++) {
    for (let col = 0; col < TILE_BAYS; col++) {
      const x0 = col * CELL;
      const y0 = row * CELL;
      if (zone === "storey") storeyCell(png, plan, x0, y0, cell, paintBalcony);
      else shopCell(png, plan, x0, y0, cell);
      cell++;
    }
  }
  return PNG.sync.write(png);
}

/** How a footprint is read as one kind of building or another. */
export interface FacadeEvidence {
  heightM: number;
  areaM2: number;
  /** The OSM `building` value, which is `yes` on two thirds of Monaco. */
  tag?: string;
}

/** Tall enough that a Monaco block is a tower rather than a house. */
const TOWER_M = 25;
const BLOCK_M = 10;
/** A plot this small is somebody's house whatever it says. */
const HOUSE_M2 = 150;
/** Low and wide is a shed, a shop or a car park, not a home. */
const WIDE_M2 = 900;

/**
 * The survey decides where it says anything, and the shape decides otherwise.
 *
 * Two thirds of Monaco's footprints are tagged `building=yes`, so a classifier
 * that trusted the tag would put one facade on the whole city. Height and area
 * are measured for every one of them.
 */
export function facadeOf({ heightM, areaM2, tag }: FacadeEvidence): Facade {
  switch (tag) {
    case "house":
    case "detached":
    case "bungalow":
    case "villa":
      return "house";
    case "retail":
    case "commercial":
    case "supermarket":
    case "kiosk":
    case "restaurant":
      return "retail";
    case "industrial":
    case "warehouse":
    case "garage":
    case "garages":
    case "parking":
    case "service":
    case "roof":
    case "construction":
      return "plain";
    case "apartments":
    case "residential":
      return heightM >= TOWER_M ? "tower" : "block";
    default:
      break;
  }
  if (heightM >= TOWER_M) return "tower";
  if (heightM < BLOCK_M && areaM2 >= WIDE_M2) return "retail";
  if (heightM < BLOCK_M && areaM2 <= HOUSE_M2) return "house";
  if (heightM < BLOCK_M) return "retail";
  return "block";
}
