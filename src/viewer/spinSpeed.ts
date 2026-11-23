// How fast Spin turns the view: the speed the orbit controls turn the camera at, about the vertical axis through the
// point it orbits, so that the structure turns once in a set time whatever the frame rate

// How long one turn takes, in seconds: slow enough to follow an atom round, and quick enough to read as moving
export const turnSeconds = 30

// The longest frame the turn keeps pace with, in seconds. A longer one, such as the frame after a rebuild of the atoms
// or a tab's return from the background, moves the turn on by this much, rather than swinging the view round
export const longestFrame = 0.1

// The orbit controls drei wraps are three-stdlib's, which turn by the same angle on every update, whatever time has
// passed, and drei updates them once a frame. three's docs give their default speed of 2 as a turn every 30 seconds at
// 60 frames a second, which is 1,800 updates, so a speed of 1 turns once every 3,600
const updatesPerTurn = 3600

// The orbit controls' speed that turns the camera by a frame's share of a turn, from how long the frame took in seconds
export function spinSpeed(frameSeconds: number) {
  return (Math.min(frameSeconds, longestFrame) * updatesPerTurn) / turnSeconds
}
