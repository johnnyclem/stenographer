// Opens a StateStore on argv[2] and closes it; prints `ok` or `FAIL <message>`.
const { StateStore } = await import('../../src/store/index.ts');
try {
  new StateStore(process.argv[2]).close();
  console.log('ok');
} catch (err) {
  console.log(`FAIL ${err instanceof Error ? err.message : err}`);
}
