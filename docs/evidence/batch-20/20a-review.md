# Batch 20A review (Reviewer 20A) - probed on a temp copy, repo untouched
Critical: none
High:
[High] packages/core/src/paths.ts:57 (used by projectReadiness, now reachable from the web) - home/state checks are case-sensitive string compares with no realpath - dir=`c:\users\yazan` (home in other case) CREATED; state dir lower-cased CREATED; a junction to home or to the state dir CREATED (all run). Same hole exists in the CLI, but POST /projects makes it a web input.
Medium:
[Medium] packages/core/src/commands/projectCreate.ts:88 - one-directory check compares resolved strings only - a junction/symlink or 8.3 name of another project's folder passes and two projects share one SCOPE.md (junction to the state dir also passes).
[Medium] packages/core/src/manager.ts:157 - 'wx' fallback: if writeFileSync throws after openSync succeeded (disk full), a partial/empty SCOPE.md stays on disk while the row rolls back; later creates then refuse "already exists". Fallback also has NO test (I ran it: fresh=true, existing=false, no temp left - works, but unguarded).
Low:
[Low] packages/core/src/commands/projectCreate.ts:98 - link succeeds, then a crash before COMMIT strands SCOPE.md with no row; kill -9 between writeFileSync and finally leaves SCOPE.md.tmp-<pid>-<hex> in the owner's folder.
[Low] packages/core/src/paths.ts:64 - a dir INSIDE the state dir (state\sub) is accepted; only "is or contains" is refused, so a worker there can still reach Magarine's database's neighbours.
[Low] packages/core/src/daemonApi.ts:355 - isAbsolute accepts rooted-no-drive `\foo` on Windows (resolves to the daemon's current drive); not a bypass, but the "absolute" sentence is inaccurate for it.
Verified fine: SCOPE.md never overwritten by linkSync (race hook: OWNER kept, row refused), by the wx path, or with an existing file; dangling-symlink SCOPE.md not testable here (EPERM symlink); dupes case-fold on Windows (REAL vs real refused); existing rows untouched; 401 test present; validation precedes writes; CLI diff otherwise unchanged (only --dir on the 2 approved tests + testDaemon per-project dirs). Tests not run.
