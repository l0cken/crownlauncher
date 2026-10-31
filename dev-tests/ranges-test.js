const { satisfies } = require('C:/Users/meabx/Desktop/CrownLauncher/src/main/core/bundled-mods.js');
const cases = [
  ['26.1.2', '~26.1-', true], ['26.1.2', '^26.1-', true], ['26.2', '~26.1-', false], ['26.1', '~26.1-', true],
  ['1.21.11', '1.21.x', true], ['1.21.11', '~1.21.5', true], ['1.22', '~1.21.5', false], ['1.21.4', '>=1.21.5', false],
  ['26.1.2', '>=26.1 <=26.1.2', true], ['26.1.2', '1.21.11', false], ['1.21.6', '1.21.5', false], ['1.21.6', '>=1.21.5-', true],
  ['21', '>=21', true], ['21', '>=22', false], ['25', '>=22', true], ['0.134.1+1.21.9', '>=0.100.0', true],
  ['0.134.1+1.21.9', '>=0.138.3', false], ['5.0.0+d32f812d9c', '>=5.0.1', false], ['1.21.5', ['1.21.4', '1.21.5'], true],
];
let bad = 0;
for (const [v, spec, want] of cases) {
  const got = satisfies(v, spec);
  if (got !== want) { bad++; console.log(`BLAD: satisfies(${v}, ${JSON.stringify(spec)}) = ${got}, oczekiwano ${want}`); }
}
console.log(bad ? `niepowodzenia: ${bad}` : `zakresy wersji: ${cases.length}/${cases.length} OK`);