import { expect, test } from "bun:test"
import { bucketMessages } from "./usage"

const HOUR = 3_600_000

test("bucketMessages sums assistant turns per hour and model", () => {
  const msg = (created: number, cost: number, id = "claude") =>
    ({
      type: "assistant",
      id: String(created),
      time: { created },
      agent: "build",
      model: { providerID: "anthropic", id },
      content: [],
      cost,
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 2 } },
    }) as never
  const out = bucketMessages([msg(HOUR + 1, 0.1), msg(HOUR + 5000, 0.2), msg(2 * HOUR, 0.3), msg(HOUR, 1, "other"), { type: "user" } as never])
  const first = out.find((b) => b.hour === HOUR && b.model === "anthropic/claude")!
  expect(first.cost).toBeCloseTo(0.3)
  expect(first.turns).toBe(2)
  expect(first.cacheRead).toBe(200)
  expect(out).toHaveLength(3)
})
