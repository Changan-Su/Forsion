export const PUBLIC_PLUGIN_IDS: readonly string[]
export function checkSourcePaths(paths: readonly string[]): void
export function checkBundleInputs(inputs: readonly string[], repositoryRoot: string): void
export function validateDistribution(directory: string): Promise<void>
