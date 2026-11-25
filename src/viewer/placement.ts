import { Matrix4, type Object3D, type Quaternion, type Ray, type Vector3 } from 'three'

// Where the structure is drawn: every style's meshes are children of one object, the structure's, and draw the atoms
// where the file puts them, in the file's own coordinates, while the object's matrix turns the structure about its
// centre and shifts that centre to the origin. Nothing drawn is moved by rewriting what it draws

// Places an object so that it turns what it holds about a centre by a rotation and then shifts the centre to the
// origin: a point p of its own goes to R(p − c). The object hangs from the scene itself, and its world matrix is
// brought up to date at once, so that a pick made before the next render finds it where it now is
export function placeStructure(object: Object3D, center: Vector3, rotation: Quaternion) {
  object.quaternion.copy(rotation)
  object.position.copy(center).applyQuaternion(rotation).negate()
  object.updateMatrixWorld()
}

const inverse = new Matrix4()

// Writes into target a ray in scene coordinates taken into an object's own space, as its world matrix last left it.
// The object's matrix is rigid, so a distance along the ray is the same in both, and its direction keeps unit length
export function rayInto(ray: Ray, object: Object3D, target: Ray) {
  return target.copy(ray).applyMatrix4(inverse.copy(object.matrixWorld).invert())
}
