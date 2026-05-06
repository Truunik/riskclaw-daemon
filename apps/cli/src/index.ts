#!/usr/bin/env bun
import { buildContext, registry } from '@claw/daemon';
import { buildExactInputSingleCalldata } from '@claw/protocols';

const [, , cmd, ...args] = process.argv;

function parseAmount(s: string): bigint {
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return BigInt(m!) * 10n ** BigInt(e!);
  }
  return BigInt(s);
}

function defaultMegaethRpc(chainId: number): string {
  return chainId === 4326
    ? 'https://mainnet.megaeth.com/rpc'
    : 'https://carrot.megaeth.com/rpc';
}

async function main() {
  switch (cmd) {
    case 'skills': {
      const rows = registry.list().map(s => ({
        name: s.manifest.name,
        chain: s.manifest.chain.name,
        mode: s.manifest.streaming ? 'streaming' : 'request',
        handlers: s.manifest.handlers?.join(',') ?? '-',
        desc: s.manifest.description,
      }));
      const nameW = Math.max(...rows.map(r => r.name.length));
      const chainW = Math.max(...rows.map(r => r.chain.length));
      for (const r of rows) {
        console.log(
          `${r.name.padEnd(nameW)}  ${r.chain.padEnd(chainW)}  ${r.mode.padEnd(9)}  handlers=${r.handlers}  ${r.desc}`,
        );
      }
      return;
    }

    case 'run': {
      const name = args[0];
      if (!name) die('usage: claw run <skill>');
      const skill = registry.get(name);
      if (!skill) die(`unknown skill: ${name}`);
      if (!skill.start) die(`skill ${name} is not streaming — use 'claw invoke'`);
      const ctx = buildContext(skill.manifest, process.env);
      await skill.start(ctx);
      return;
    }

    case 'invoke': {
      const [name, handler, ...rest] = args;
      if (!name || !handler) die('usage: claw invoke <skill> <handler> [json]');
      const skill = registry.get(name);
      if (!skill?.handlers?.[handler]) die(`no handler '${handler}' on '${name}'`);
      const ctx = buildContext(skill.manifest, process.env);
      const reqJson = rest.length ? rest.join(' ') : '{}';
      const req = JSON.parse(reqJson);
      const result = await skill.handlers[handler](req, ctx);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'preflight': {
      const [protocol, pool, amountInStr, amountOutMinStr] = args;
      if (protocol !== 'kumbaya') {
        die(`unsupported protocol: ${protocol ?? '(missing)'} (currently supported: kumbaya)`);
      }
      if (!pool || !amountInStr || amountOutMinStr === undefined) {
        die('usage: claw preflight kumbaya <pool> <amountIn> <amountOutMin>');
      }

      const chainId = Number(process.env.MEGAETH_CHAIN_ID ?? 4326);
      process.env.MEGAETH_CHAIN_ID = String(chainId);
      if (!process.env.MEGAETH_RPC_URL) process.env.MEGAETH_RPC_URL = defaultMegaethRpc(chainId);

      const skill = registry.get('mega-preflight');
      if (!skill?.handlers?.check) die('mega-preflight not registered');
      const ctx = buildContext(skill.manifest, process.env);

      const built = await buildExactInputSingleCalldata({
        pool,
        amountIn: parseAmount(amountInStr),
        amountOutMinimum: parseAmount(amountOutMinStr),
        recipient: '0x0000000000000000000000000000000000000001',
        chainId,
        ctx,
      });

      console.log(`# preflight kumbaya — chain ${chainId} via ${process.env.MEGAETH_RPC_URL}`);
      console.log(`# pool   ${pool}`);
      console.log(`# tokenIn  ${built.tokenIn}`);
      console.log(`# tokenOut ${built.tokenOut}`);
      console.log(`# fee      ${built.fee}`);
      console.log(`# router   ${built.router}`);
      console.log('');

      const result = await skill.handlers.check(
        {
          from: '0x0000000000000000000000000000000000000001',
          to: built.router,
          data: built.data,
        },
        ctx,
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    default: {
      console.log('claw — riskclaw-daemon CLI');
      console.log('');
      console.log('  claw skills                                            list registered skills');
      console.log('  claw run <skill>                                       start a streaming skill');
      console.log('  claw invoke <skill> <handler> [json]                   call a request/response handler');
      console.log('  claw preflight kumbaya <pool> <amountIn> <amountOutMin>');
      console.log('                                                         pre-flight a Kumbaya swap (defaults to mainnet)');
      console.log('');
      console.log('env:');
      console.log('  MEGAETH_CHAIN_ID     4326 (mainnet, default for preflight) or 6343 (testnet)');
      console.log('  MEGAETH_RPC_URL      defaults: mainnet=https://mainnet.megaeth.com/rpc, testnet=https://carrot.megaeth.com/rpc');
    }
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
