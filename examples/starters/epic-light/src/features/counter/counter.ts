export interface Counter {
  readonly count: number
}

export const make = (): Counter => ({ count: 0 })

export const increment = (counter: Counter): Counter => ({ count: counter.count + 1 })

export const reset = (_counter: Counter): Counter => make()
