import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const [batch, phase] = process.argv.slice(2);
mkdirSync('test-results/tdd', { recursive: true });
const commands = phase === 'refactor' ? ['test', 'typecheck', 'lint'] : ['test'];
let failed = false;
for (const command of commands) {
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command === 'test' ? 'npm test' : `npm run ${command}`], { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(`test-results/tdd/${batch}-${phase}-${command}.log`, output);
  console.log(`${batch} ${phase} ${command}: exit=${result.status}\n${output.slice(-2400)}`);
  failed ||= result.status !== 0;
}
if (phase === 'red' ? !failed : failed) process.exitCode = 1;
