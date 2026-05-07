import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, registry, auditProtocol } from '@claw/daemon';
import { buildExactInputSingleCalldata } from '@claw/protocols';

interface BunFile extends Blob { exists(): Promise<boolean> }
interface BunServer {
  port: number;
  stop(): void;
  requestIP(req: Request): { address: string; family: string; port: number } | null;
}
declare const Bun: {
  serve(cfg: {
    port: number;
    idleTimeout?: number;
    fetch: (req: Request, server: BunServer) => Response | Promise<Response>;
  }): BunServer;
  file(path: string): BunFile;
};

const PORT = Number(process.env.PORT ?? 4242);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const PREFLIGHT_PROTOCOLS = new Set(['kumbaya']);
const SCORE_PROTOCOLS = new Set(['kumbaya', 'prism']);
const ALLOWED_CHAIN_IDS = new Set([4326, 6343]);

const RPC_TIMEOUT_MS = 15_000;
const AUDIT_TIMEOUT_MS = 180_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const ipHits = new Map<string, number[]>();

function rateLimit(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (ipHits.get(ip) ?? []).filter(t => t > cutoff);
  if (hits.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((hits[0]! + RATE_LIMIT_WINDOW_MS - now) / 1000);
    ipHits.set(ip, hits);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return { ok: true };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface PreflightBody {
  protocol?: string;
  pool?: string;
  amountIn?: string;
  amountOutMinimum?: string;
  chainId?: number;
}

interface ScoreBody {
  protocol?: string;
  pool?: string;
  amountIn?: string;
  chainId?: number;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function parseAmount(s: string): bigint {
  if (!/^[0-9]+(e[0-9]+)?$/.test(s)) throw new Error(`bad amount: ${s}`);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return BigInt(m!) * 10n ** BigInt(e!);
  }
  return BigInt(s);
}

function defaultMegaethRpc(chainId: number): string {
  return chainId === 4326 ? 'https://mainnet.megaeth.com/rpc' : 'https://carrot.megaeth.com/rpc';
}

async function handlePreflight(body: PreflightBody): Promise<unknown> {
  const protocol = body.protocol ?? 'kumbaya';
  if (!PREFLIGHT_PROTOCOLS.has(protocol)) {
    throw new Error(`unsupported protocol: ${protocol} (preflight supports: ${[...PREFLIGHT_PROTOCOLS].join(', ')})`);
  }
  if (!isHexAddress(body.pool)) throw new Error('pool must be a 0x-prefixed 20-byte address');
  if (typeof body.amountIn !== 'string') throw new Error('amountIn required');
  if (typeof body.amountOutMinimum !== 'string') throw new Error('amountOutMinimum required');

  const chainId = body.chainId ?? 4326;
  if (!ALLOWED_CHAIN_IDS.has(chainId)) throw new Error(`unsupported chainId: ${chainId}`);

  const env: Record<string, string | undefined> = {
    ...process.env,
    MEGAETH_CHAIN_ID: String(chainId),
    MEGAETH_RPC_URL: process.env.MEGAETH_RPC_URL ?? defaultMegaethRpc(chainId),
  };

  const skill = registry.get('mega-preflight');
  if (!skill?.handlers?.check) throw new Error('mega-preflight not registered');
  const ctx = buildContext(skill.manifest, env);

  const built = await buildExactInputSingleCalldata({
    pool: body.pool,
    amountIn: parseAmount(body.amountIn),
    amountOutMinimum: parseAmount(body.amountOutMinimum),
    recipient: '0x0000000000000000000000000000000000000001',
    chainId,
    ctx,
  });

  const verdict = await skill.handlers.check(
    {
      from: '0x0000000000000000000000000000000000000001',
      to: built.router,
      data: built.data,
    },
    ctx,
  );

  return {
    request: {
      protocol,
      chainId,
      pool: body.pool,
      tokenIn: built.tokenIn,
      tokenOut: built.tokenOut,
      fee: built.fee,
      router: built.router,
    },
    verdict,
  };
}

interface PreflightRawBody {
  to?: string;
  data?: string;
  from?: string;
  chainId?: number;
}

async function handlePreflightRaw(body: PreflightRawBody): Promise<unknown> {
  if (!isHexAddress(body.to)) throw new Error('to must be a 0x-prefixed 20-byte address');
  if (typeof body.data !== 'string' || !body.data.startsWith('0x')) {
    throw new Error('data must be 0x-prefixed hex calldata');
  }
  const chainId = body.chainId ?? 4326;
  if (!ALLOWED_CHAIN_IDS.has(chainId)) throw new Error(`unsupported chainId: ${chainId}`);

  const from = body.from && isHexAddress(body.from) ? body.from : '0x0000000000000000000000000000000000000001';

  const env: Record<string, string | undefined> = {
    ...process.env,
    MEGAETH_CHAIN_ID: String(chainId),
    MEGAETH_RPC_URL: process.env.MEGAETH_RPC_URL ?? defaultMegaethRpc(chainId),
  };

  const skill = registry.get('mega-preflight');
  if (!skill?.handlers?.check) throw new Error('mega-preflight not registered');
  const ctx = buildContext(skill.manifest, env);

  const verdict = await skill.handlers.check({ from, to: body.to, data: body.data }, ctx);
  return { request: { chainId, to: body.to, from }, verdict };
}

async function handleScore(body: ScoreBody): Promise<unknown> {
  const protocol = body.protocol;
  if (!protocol || !SCORE_PROTOCOLS.has(protocol)) {
    throw new Error(`unsupported protocol: ${protocol ?? '(missing)'} (score supports: ${[...SCORE_PROTOCOLS].join(', ')})`);
  }
  if (!isHexAddress(body.pool)) throw new Error('pool must be a 0x-prefixed 20-byte address');

  const chainId = body.chainId ?? 4326;
  if (!ALLOWED_CHAIN_IDS.has(chainId)) throw new Error(`unsupported chainId: ${chainId}`);

  const env: Record<string, string | undefined> = {
    ...process.env,
    MEGAETH_CHAIN_ID: String(chainId),
    MEGAETH_RPC_URL: process.env.MEGAETH_RPC_URL ?? defaultMegaethRpc(chainId),
  };

  const skill = registry.get('mega-aggregator');
  if (!skill?.handlers?.score) throw new Error('mega-aggregator not registered');
  const ctx = buildContext(skill.manifest, env);

  const result = await skill.handlers.score(
    {
      amountIn: body.amountIn ?? '1000000',
      hops: [{
        address: body.pool,
        protocol,
        fromToken: '0x0000000000000000000000000000000000000000',
        toToken: '0x0000000000000000000000000000000000000000',
      }],
    },
    ctx,
  );

  return { request: { protocol, chainId, pool: body.pool }, result };
}

const server = Bun.serve({
  port: PORT,
  // Audits walk full pool history + score each — can take 2–3 min on public RPC.
  // Bun caps idleTimeout at 255s.
  idleTimeout: 240,
  async fetch(req, srv) {
    const url = new URL(req.url);

    const RPC_PATHS = new Set(['/api/preflight', '/api/preflight-raw', '/api/score']);
    if (RPC_PATHS.has(url.pathname) && req.method === 'POST') {
      const ip = srv.requestIP(req)?.address ?? 'unknown';
      const rl = rateLimit(ip);
      if (!rl.ok) {
        return Response.json(
          { error: `rate limit exceeded — ${RATE_LIMIT_MAX} req/min/ip; retry in ${rl.retryAfter}s` },
          { status: 429, headers: { 'retry-after': String(rl.retryAfter) } },
        );
      }
      try {
        const body = await req.json();
        let handler: Promise<unknown>;
        if (url.pathname === '/api/preflight') handler = handlePreflight(body as PreflightBody);
        else if (url.pathname === '/api/preflight-raw') handler = handlePreflightRaw(body as PreflightRawBody);
        else handler = handleScore(body as ScoreBody);
        const result = await withTimeout(handler, RPC_TIMEOUT_MS, url.pathname);
        return Response.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    if (url.pathname === '/api/audit' && req.method === 'GET') {
      const ip = srv.requestIP(req)?.address ?? 'unknown';
      const rl = rateLimit(ip);
      if (!rl.ok) {
        return Response.json(
          { error: `rate limit exceeded — ${RATE_LIMIT_MAX} req/min/ip; retry in ${rl.retryAfter}s` },
          { status: 429, headers: { 'retry-after': String(rl.retryAfter) } },
        );
      }
      const protocol = url.searchParams.get('protocol');
      const chainArg = url.searchParams.get('chainId') ?? '4326';
      const chainId = Number(chainArg);
      if (protocol !== 'kumbaya' && protocol !== 'prism') {
        return Response.json({ error: `unsupported protocol: ${protocol ?? '(missing)'} — use kumbaya or prism` }, { status: 400 });
      }
      if (!ALLOWED_CHAIN_IDS.has(chainId)) {
        return Response.json({ error: `unsupported chainId: ${chainId}` }, { status: 400 });
      }
      try {
        const audit = await withTimeout(
          auditProtocol({ protocol, chainId }),
          AUDIT_TIMEOUT_MS,
          '/api/audit',
        );
        return Response.json(audit);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    if (url.pathname === '/api/integrations' && req.method === 'GET') {
      return Response.json({
        integrations: [
          {
            name: 'kumbaya',
            display: 'Kumbaya',
            kind: 'UniV3 fork DEX',
            chains: [4326, 6343],
            status: 'live',
            surfaces: ['preflight', 'aggregator-score'],
            catches: [
              'amountOutMinimum=0 — zero slippage protection (MEV sandwich risk)',
              'V3 oracle observationCardinality < 10 — TWAP unreliable',
              'Pool liquidity < 1e6 — thin / dead',
              'TVL drift via balanceOf at latest vs latest-300 blocks',
              'Reentrancy lock state at read time',
              'Sim revert classification (downgrade if recognized protocol)',
            ],
          },
          {
            name: 'prism',
            display: 'Prism',
            kind: 'UniV3 DEX (custom-fee variants)',
            chains: [4326],
            status: 'live',
            surfaces: ['preflight (router-recognized)', 'aggregator-score'],
            catches: [
              'UniversalRouter target recognition (router 0x955d56…223f, factory-verified)',
              'Pool liquidity depth + reentrancy state',
              'V3 oracle observationCardinality',
              'TVL drift over last ~5 minutes',
            ],
            notes:
              'UniversalRouter calldata uses a command-stream encoding that is not yet decoded (same gap as Kumbaya UniversalRouter). SwapRouter02 / QuoterV2 / SelectiveTaxRouter addresses still pending publication.',
          },
        ],
      });
    }

    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    const filePath = join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) return new Response('not found', { status: 404 });

    const direct = Bun.file(filePath);
    if (await direct.exists()) return new Response(direct);

    if (!pathname.includes('.')) {
      const html = Bun.file(filePath + '.html');
      if (await html.exists()) return new Response(html);
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`riskclaw web — http://localhost:${server.port}`);
