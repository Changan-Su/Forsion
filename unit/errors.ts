/** A rule violation whose message is safe to show in a job record (ids only, never paths). */
export class OperationError extends Error {}
/**
 * The plugin left the running Unit, but stopping it or resyncing runtimes failed, so something may
 * still use its version directory. That directory must be kept, and the job says so.
 */
export class RollbackIncomplete extends OperationError {}
