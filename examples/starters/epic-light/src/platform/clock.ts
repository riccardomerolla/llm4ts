/** Legacy helper nobody owns; its test has been red for a while. */
export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
