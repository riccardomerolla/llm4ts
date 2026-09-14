Regexes miss links in complex COBOL/JCL sources: dynamic CALLs (CALL WS-PROGRAM
where the target sits in WORKING-STORAGE), JCL symbolic parameters (EXEC
PGM=&PGM set earlier in the job or in a PROC), PROC expansions, control cards
and SYSIN members naming programs, and COPY REPLACING variants. Prioritise jobs
with fewer outgoing edges than steps, programs nothing references, and copybooks
with degree 0. Calls to system or runtime services (CEE*, DFH*, IGZ*, SQL
preprocessor stubs) are not estate edges — note them.
