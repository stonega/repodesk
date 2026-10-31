# Browser deployment: inherited encryption-key mounts were omitted

## Impact

The operator-authorized Browser rollout stopped the application and worker during
cutover on 2026-10-31. Both replacement writers failed configuration loading, so
the deployment gate stopped them and retained the previous release marker. The
public entry was unavailable during recovery and returned ready again at
04:45:37 UTC. The interruption began during the cutover around 04:41 UTC.
No database restore was performed. The pre-release backup was verified and the
additive Browser table migration was retained. Existing credentials, persistent
volumes, PostgreSQL and CI runners were preserved.

## Cause

The deployment-only flattened Compose file was generated without resolving YAML
merge keys first. Its explicit Browser secret list shadowed the encryption-key
secret inherited through the runtime anchor. API and worker retained
`ENCRYPTION_KEY_FILE` but lacked its file mount, causing `ENOENT` before startup.
The migration service retained its inherited secret and completed successfully.

The repository's normal base plus Browser Compose overlay was correct. The
packaging conversion introduced the missing mounts. The original preflight
checked secret access only through the migration service, so it did not catch the
different application-service mounts. Deterministic integration tests and the
offline runtime contract did not exercise this deployment-specific composition.

## Recovery and prevention

The previous release's full Compose configuration restored API, worker, runner
and Code Truth. Protected failed-startup logs were retained; inspection exposed
only fixed error classes, codes and stack locations.

The corrected flattened configuration resolves YAML merges before adding Browser
bindings and is compared with Docker Compose's official multi-file merge after
environment normalization. `scripts/deploy-vps.sh` now checks encryption-key
readability as each of migrate, API and worker before stopping production.
Deterministic regressions invoke the production deployment script with missing
API or worker mounts and require failure before writer shutdown, backup or
promotion. The next cutover uses a new release directory and a new backup.

Separate native-host checks also found and repaired Ubuntu nft stdin compatibility,
socket readiness timing and runtime-directory preservation across service restart.
These were verified independently of application readiness. Live account login
and unsolicited Telegram messages are not deployment probes.

## Follow-up outcome

Fresh release `41170079370-1` completed successfully after semantic comparison with
the official Compose merge and all three service secret-access preflights. Its
verified backup is separate from the failed attempt's backup. All runtime services,
public/loopback assets and 51 image artifacts pass. The final regression suite
passes 1,365 tests. A real host-service restart also confirms that existing API and
worker Browser mounts reconnect without container replacement.
