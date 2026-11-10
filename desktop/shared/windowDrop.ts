export interface WindowDropPoint {
  localX: number
  localY: number
  viewType: string
}

export interface WindowView {
  type: string
  params?: Record<string, unknown>
}
