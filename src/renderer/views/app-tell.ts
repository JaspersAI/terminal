import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

// What a server's page is told when it says it is initialized, and in what order. No DOM and no
// bridge of its own: the view hands in the bridge and the call, so the order is tested here.

/** The part of the host's bridge that tells a page things. */
export interface PageBridge {
  sendToolInput(params: { arguments?: Record<string, unknown> }): Promise<void>
  sendToolResult(result: CallToolResult): Promise<void>
}

/** What a panel's opening gave: the tool's input, and its result when one was kept. */
interface Opening {
  input: Record<string, unknown>
  result: unknown | null
}

/**
 * The teller for one frame. Called each time the frame's page says it is initialized, it tells the
 * page the input and then the result, and answers the result, or null when the frame was gone first.
 *
 * The result is the kept one, or the panel's call made now, and the call is made once for the frame
 * however often its page initializes. A page does that more than once when it mounts twice or loads
 * itself again, and a call each time would start a tool that starts something a second time, and
 * would let a page call its panel's tool as the assistant does whenever it liked. A call that
 * brought nothing back is told as the refusal it is, and told again the same way: refreshing the
 * panel is what calls again.
 */
export function pageTeller(
  opening: Opening,
  run: () => Promise<unknown>,
): (bridge: PageBridge, alive: () => boolean) => Promise<CallToolResult | null> {
  let answer: Promise<CallToolResult> | null =
    opening.result === null ? null : Promise.resolve(opening.result as CallToolResult)
  return async (bridge, alive) => {
    await bridge.sendToolInput({ arguments: opening.input })
    answer ??= run().then((result) => result as CallToolResult, refusal)
    const result = await answer
    if (!alive()) return null
    await bridge.sendToolResult(result)
    return result
  }
}

function refusal(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] }
}
