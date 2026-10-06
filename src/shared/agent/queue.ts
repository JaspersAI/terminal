// Which runs wait. The user's own never do: each request starts as it is sent, beside whatever is
// already running, on its own copy of the thread (fork.ts). The runs nobody is sitting in front of, a
// scheduled task's and the welcome's, are the ones held to a few at a time, so a burst of due tasks
// cannot fan out, and they never hold the user's back since the user's are not counted.
//
// Pure, so the rule can be read in a test rather than inferred from timing.

/** How many background runs may be in flight at once. */
export const BACKGROUND_MAX = 2

/** Whether another background run may start now, with this many in flight. */
export function canStart(running: number): boolean {
  return running < BACKGROUND_MAX
}
