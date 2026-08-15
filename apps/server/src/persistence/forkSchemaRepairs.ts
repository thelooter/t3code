/**
 * Records fork schema repairs performed during this server process, so the
 * config surface can report them to connected clients.
 *
 * Deliberately a module-scoped record rather than an Effect service: the
 * repair happens inside the persistence layer's setup, and the reader is the
 * websocket config assembly, which has no SQL access. Threading a service
 * between them would mean changing the layer graph in `Layers/Sqlite.ts` and
 * `ws.ts` -- both upstream-owned -- for a value that is written once at boot
 * and never changes for the life of the process.
 *
 * Scoped to the process on purpose. The repair itself is already done and
 * cannot recur on the next boot (the columns exist again), so the warning has
 * exactly one useful lifetime: the session in which it happened. Clients that
 * connect or reconnect during that session all see it, because it rides on
 * `ServerConfig` rather than a one-shot event.
 */

let restoredColumns: ReadonlyArray<string> = [];

export const recordForkSchemaRepair = (columns: ReadonlyArray<string>): void => {
  if (columns.length === 0) {
    return;
  }
  restoredColumns = [...new Set([...restoredColumns, ...columns])].sort();
};

export const getForkSchemaRepairs = (): ReadonlyArray<string> => restoredColumns;

/** Test-only: the module record outlives an individual in-memory database. */
export const resetForkSchemaRepairs = (): void => {
  restoredColumns = [];
};
