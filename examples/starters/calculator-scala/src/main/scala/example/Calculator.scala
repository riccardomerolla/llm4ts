package example

object Calculator:

  def add(a: Int, b: Int): Int = a + b

  def subtract(a: Int, b: Int): Int = a - b

  /** Arithmetic mean of a list of integers.
    *
    * BUG: this throws `ArithmeticException` on an empty list instead of
    * handling the case explicitly. The issue-driven flow can reproduce it with
    * a failing test and implement the requested behavior.
    */
  def average(nums: List[Int]): Int =
    nums.sum / nums.size
