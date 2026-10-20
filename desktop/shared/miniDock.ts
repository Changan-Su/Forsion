/** Coordinates are screen DIPs; renderer compensates for the user's CSS UI zoom. */
export interface MiniDockMotion {
  id: number
  x: number
  y: number
  animate: boolean
}
