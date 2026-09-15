In a COBOL estate a domain feature is a job's worth of business behaviour: the
program a JCL step executes together with every program it CALLs and the
copybooks they share, or a set of programs that post to the same ledger
tables. Copybooks are context, never features of their own. Programs that
only compute (fee, interest, limit) and are CALLed from several jobs belong to
the feature that owns their business rule, not to every caller; say which in
the evidence. Never join two batch jobs that touch different ledgers unless
one executes the other.
