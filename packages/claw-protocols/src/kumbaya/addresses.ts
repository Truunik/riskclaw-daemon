export interface KumbayaAddresses {
  factory: string;
  router02: string;
  universalRouter: string;
  positionManager: string;
  quoter: string;
  weth: string;
}

// Source: github.com/zgos/Kumbaya-xyz-integrator-kit/addresses/
export const KUMBAYA_ADDRESSES: Record<number, KumbayaAddresses> = {
  // MegaETH mainnet
  4326: {
    factory: '0x68b34591f662508076927803c567Cc8006988a09',
    router02: '0xE5BbEF8De2DB447a7432A47EBa58924d94eE470e',
    universalRouter: '0xAAB1C664CeaD881AfBB58555e6A3a79523D3e4C0',
    positionManager: '0x2b781C57e6358f64864Ff8EC464a03Fdaf9974bA',
    quoter: '0x1F1a8dC7E138C34b503Ca080962aC10B75384a27',
    weth: '0x4200000000000000000000000000000000000006',
  },
  // MegaETH testnet (Carrot)
  6343: {
    factory: '0x53447989580f541bc138d29A0FcCf72AfbBE1355',
    router02: '0x8268DC930BA98759E916DEd4c9F367A844814023',
    universalRouter: '0x7E6c4Ada91e432efe5F01FbCb3492Bd3eb7ccD2E',
    positionManager: '0x367f9db1F974eA241ba046b77B87C58e2947d8dF',
    quoter: '0xfb230b93803F90238cB03f254452bA3a3b0Ec38d',
    weth: '0x4200000000000000000000000000000000000006',
  },
};

export const KUMBAYA_POOL_INIT_CODE_HASH =
  '0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7';

export function kumbayaContracts(chainId: number): Set<string> {
  const a = KUMBAYA_ADDRESSES[chainId];
  if (!a) return new Set();
  return new Set(
    [a.factory, a.router02, a.universalRouter, a.positionManager, a.quoter].map(x => x.toLowerCase()),
  );
}
