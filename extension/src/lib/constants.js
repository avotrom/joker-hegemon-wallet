// Network identity for Hegemon v0.11 pre-mainnet (software v0.11.4).
// Source: Pauli-Group/Hegemon config/testnet/0.11/release.json.
export const NETWORK = {
  name: 'Hegemon pre-mainnet v0.11',
  profile: 'pre-mainnet',
  genesis: '0xd9a8cfc158790b0251c7493d7261da771f7d57be63bce750ba8c1af5d92a9ad3',
  chainId: '0x7b7b0899d5444ffd92c38b38188e9ce4f891913ca7cca854fdcae0aa22ca1b49',
  manifestSha256: '386f21b8d9b474fce096c0691ec7d625f292e9aadf0cd5f06fb4088442ec6754',
  minSoftware: '0.11.4',
  // v0.11.4 combined upgrade height (ASERT, version rolling, treasury batches).
  upgradeHeight: 18660,
  targetBlockSecs: 60,
  // PrivateSpend proofs reference a parent; inclusion must happen within 12 blocks.
  referenceWindow: 12,
  coinbaseMaturity: 120,
};

export const HGN_DECIMALS = 8;
export const ATOMS_PER_HGN = 100_000_000n;

// Fee presets in atoms. 0.00001 HGN is the fee used in the v0.11 cutover payment.
export const FEES = {
  economy: 500n,
  normal: 1_000n,
  priority: 5_000n,
};

export const DEFAULT_SETTINGS = {
  nodes: [{ url: 'http://127.0.0.1:9944', label: 'My node (this Mac)' }],
  activeNode: 0,
  tor: { enabled: false, host: '127.0.0.1', port: 9050 },
  dandelion: { enabled: true, minDelay: 2, maxDelay: 20 },
  autoLockMinutes: 15,
  hideAmounts: false,
  notifications: { received: true, confirmed: true, failed: true, node: true },
  feePreset: 'normal',
  confirmationsTarget: 6,
  syncBatchBlocks: 64,
  syncEveryMinutes: 1,
};

// JSON-RPC admission errors from PUBLIC_SUBMIT_WALLET_INTEGRATION.md.
export const RPC_ADMISSION = {
  [-32055]: { retry: false, uncertain: true, text: 'Node response was too large — the send may already be accepted' },
  [-32056]: { retry: true, uncertain: false, text: 'Node timed out reading the request' },
  [-32070]: { retry: true, uncertain: false, text: 'Too many sends from this IP — wait a minute' },
  [-32071]: { retry: true, uncertain: false, text: 'Node client table is full' },
  [-32072]: { retry: true, uncertain: false, text: 'Node is busy' },
  [-32073]: { retry: true, uncertain: false, text: 'Node verifier is busy' },
  [-32075]: { retry: true, uncertain: false, text: 'Rate limit reached on this node' },
};
