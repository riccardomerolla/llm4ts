Units are COBOL programs, copybooks, and JCL jobs. Copybooks with many callers
are shared data contracts — migrate them with their first consumer or wrap them.
Jobs are scheduler entry points: a job nothing calls is still live if a
scheduler runs it, so it is a "wrap" (keep on the platform, front with an API)
until every program it steps through has been rewritten, never a "retire" on
graph evidence alone. Programs with no callers and no job step are the retire
candidates; give the degree evidence. Batch windows and EOD chains make good
wave boundaries: keep a job's step programs in the same or an earlier wave.
