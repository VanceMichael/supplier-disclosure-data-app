// 命令行入口：
//   ingest <csv目录> [--store data/events.jsonl] [--no-validate]
//   disclosure <客户> --as-of <月>
//   committee --as-of <月>
//   baseline --as-of <月>
//   decomposition <客户> --as-of <月>
//   revocation --as-of <月>
//   snapshots --as-of <月>
//   enter <表名> --field=value ...
import { argv, exit } from 'node:process';
import { resolve } from 'node:path';
import { DisclosureService } from './service.mjs';

const DEFAULT_STORE = 'data/events.jsonl';

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[body] = args[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main() {
  const [command, ...rest] = argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const storePath = resolve(flags.store || DEFAULT_STORE);
  const service = DisclosureService.fromFile(storePath);
  const asOf = Number(flags['as-of'] || 3);
  const print = value => console.log(JSON.stringify(value, null, 2));

  switch (command) {
    case 'ingest': {
      const folder = resolve(positional[0] || 'fixtures');
      const count = await service.loadFolder(folder, { validateLinks: flags.validate !== false });
      print({ 状态: '已装载', 事件数: count, 存储: storePath });
      break;
    }
    case 'enter': {
      const [table] = positional;
      const values = {};
      for (const [key, value] of Object.entries(flags)) values[key] = value;
      const row = service.enter(table, values);
      print({ 状态: '已录入', table, row });
      break;
    }
    case 'disclosure': {
      const pack = service.disclosureFor(positional[0], asOf);
      delete pack._run;
      print(pack);
      break;
    }
    case 'committee':
      print(service.committee(asOf));
      break;
    case 'baseline':
      print(service.runAt(asOf).baselines);
      break;
    case 'decomposition':
      print(service.runAt(asOf).decompositions.find(d => d.client === positional[0]));
      break;
    case 'revocation':
      print(service.revocationWorkbench(asOf));
      break;
    case 'snapshots':
      print(service.issueSnapshots(asOf));
      break;
    case 'tables':
      print(service.tables());
      break;
    default:
      console.error('可用命令: ingest | enter | disclosure | committee | baseline | decomposition | revocation | snapshots | tables');
      exit(1);
  }
}

main().catch(error => {
  console.error(`错误：${error.message}`);
  exit(1);
});
