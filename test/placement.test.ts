import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Group, Quaternion, Ray, Vector3 } from 'three'
import { placeStructure, rayInto } from '../src/viewer/placement.ts'

// The structure's object, which turns the structure about its centre and shifts that centre to the origin, and a ray
// taken into its space, where the atoms are tested

// A structure's centre where a file might put it, and a turn of 70° about an oblique axis
const centre = new Vector3(31.25, -12.5, 7.75)
const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), (70 * Math.PI) / 180)

// Whether two points agree to within rounding
function near(point: Vector3, expected: Vector3) {
  return point.distanceTo(expected) < 1e-9
}

void test('with no turn, the object puts each atom exactly where subtracting the centre would', () => {
  const object = new Group()
  placeStructure(object, centre, new Quaternion())
  for (const [x, y, z] of [
    [31.25, -12.5, 7.75],
    [12.345, 67.891, -0.001],
    [-150.5, 3.25, 98.125],
  ]) {
    const placed = new Vector3(x, y, z).applyMatrix4(object.matrixWorld)
    assert.deepEqual(placed.toArray(), [x - centre.x, y - centre.y, z - centre.z])
  }
})

void test('the object turns the structure about its centre, then shifts the centre to the origin', () => {
  const object = new Group()
  placeStructure(object, centre, turn)
  // Its world matrix is up to date at once, with no render
  assert.ok(near(centre.clone().applyMatrix4(object.matrixWorld), new Vector3()))
  // A point of the structure lands where the turn takes it from the centre
  const offset = new Vector3(2, -3, 5)
  const placed = centre.clone().add(offset).applyMatrix4(object.matrixWorld)
  assert.ok(near(placed, offset.clone().applyQuaternion(turn)))
  // The turn keeps lengths, so a structure's reach from its centre is its reach from the origin once placed
  assert.ok(Math.abs(placed.length() - offset.length()) < 1e-9)
  // Placed again, the object forgets where it was
  placeStructure(object, new Vector3(), new Quaternion())
  assert.ok(near(new Vector3(1, 2, 3).applyMatrix4(object.matrixWorld), new Vector3(1, 2, 3)))
})

void test("a ray taken into the object's space meets what the object holds as far along as in the scene", () => {
  const object = new Group()
  placeStructure(object, centre, turn)
  // An atom of the structure, where the object puts it in the scene, and a ray from a camera through it
  const atom = new Vector3(35, -10, 2)
  const seen = atom.clone().applyMatrix4(object.matrixWorld)
  const camera = new Vector3(20, 10, 150)
  const distance = seen.distanceTo(camera)
  const ray = new Ray(camera.clone(), seen.clone().sub(camera).normalize())
  const local = rayInto(ray, object, new Ray())
  assert.ok(Math.abs(local.direction.length() - 1) < 1e-12)
  assert.ok(near(local.at(distance, new Vector3()), atom))
  // The camera itself lands where the object's inverse takes it, and the ray it was taken from is left as it was
  assert.ok(near(local.origin.clone().applyMatrix4(object.matrixWorld), camera))
  assert.ok(near(ray.origin, camera))
})
