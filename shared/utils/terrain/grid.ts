import { TerrainError } from './errors'

/**
 * A row-major height grid: vertex (i, j) is `heights[j · width + i]`, `i` growing east and `j`
 * growing north, vertices `cellSize` metres apart.
 */
export interface HeightGrid {
  heights: Float32Array
  width: number
  height: number
  cellSize: number
}

/** A vertex index within a grid. */
export interface GridCell {
  i: number
  j: number
}

export function assertGridShape(
  width: number,
  height: number,
  length: number,
  context: string,
): void {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new TerrainError(
      'INVALID_GRID',
      `${context}: grid size is ${width}×${height}; pass positive integer width and height.`,
    )
  }
  if (length !== width * height) {
    throw new TerrainError(
      'INVALID_GRID',
      `${context}: array holds ${length} values but the grid is ${width}×${height} (${width * height}); pass an array of width × height values.`,
    )
  }
}

export function assertHeightGrid(grid: HeightGrid, context: string): void {
  assertGridShape(grid.width, grid.height, grid.heights.length, context)
  if (!Number.isFinite(grid.cellSize) || grid.cellSize <= 0) {
    throw new TerrainError(
      'INVALID_GRID',
      `${context}: cellSize is ${grid.cellSize}; pass a finite number greater than 0.`,
    )
  }
}

export function assertCellInGrid(
  cell: GridCell,
  width: number,
  height: number,
  context: string,
): void {
  const { i, j } = cell
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= width || j >= height) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `${context}: cell (${i}, ${j}) is outside the ${width}×${height} grid; pass integers with 0 ≤ i < ${width} and 0 ≤ j < ${height}.`,
    )
  }
}
