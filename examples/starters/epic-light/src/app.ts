import { greet } from "./features/greeting/greeting.ts"
import { increment, make } from "./features/counter/counter.ts"

/** The composition point: wires the features into one program. */
export const run = (name: string): string => {
  const counter = increment(make())
  return `${greet(name)} You have clicked ${counter.count} time(s).`
}
