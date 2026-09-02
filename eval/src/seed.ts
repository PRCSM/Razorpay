/**
 * eval seed — synthetic case generator. Scaffold only in Run 1; built in Run 2.
 *
 * Requirements it must meet when implemented:
 *   - deterministic from a seed, so a batch is reproducible
 *   - writes `is_synthetic = true` and a `ground_truth` payload on every case
 *   - a documented failure-cause distribution, not an arbitrary one
 *
 * Synthetic data never blends with live data: the honesty columns on
 * `recovery_cases` keep the two lanes separate in one database.
 */

function main(): void {
  console.log('[eval:seed] scaffold — the synthetic generator is built in Run 2.');
  console.log('[eval:seed] It will write recovery_cases with is_synthetic = true');
  console.log('[eval:seed] and a ground_truth payload per case, from a fixed seed.');
}

main();
