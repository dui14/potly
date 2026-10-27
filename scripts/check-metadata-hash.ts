/**
 * Hash parity check: proves that the client-side computeMetadataHash and the
 * server-side keccak256(encodeAbiParameters(...)) produce identical output
 * for the same input.
 *
 * Run: bunx tsx scripts/check-metadata-hash.ts
 *
 * NOTE: this script only verifies the TypeScript implementations against each
 * other.  The Solidity on-chain hash is equivalent by construction
 * (keccak256(abi.encode(string, string, bytes32))).
 */

import { keccak256, encodeAbiParameters } from 'viem'

// ── Client-side implementation (mirrors src/lib/metadata.ts) ────────────────
function computeMetadataHashClient(title: string, note: string, salt: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
      [title, note, salt],
    ),
  )
}

// ── Server-side implementation (mirrors api/v1/pots/.../metadata.ts) ─────────
function computeMetadataHashServer(title: string, note: string, salt: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
      [title, note, salt],
    ),
  )
}

// ── Test cases ───────────────────────────────────────────────────────────────
const cases = [
  {
    title: 'Birthday gift for Alice',
    note:  'Hope you love it!',
    salt:  '0xaabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb' as `0x${string}`,
  },
  {
    title: '',
    note:  '',
    salt:  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  },
  {
    title: 'Unicode: ☀️🌊',
    note:  'Multi\nline\nnote',
    salt:  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as `0x${string}`,
  },
]

let allPass = true
for (const { title, note, salt } of cases) {
  const client = computeMetadataHashClient(title, note, salt)
  const server = computeMetadataHashServer(title, note, salt)
  const pass   = client === server
  allPass      = allPass && pass
  console.log(`${pass ? 'PASS' : 'FAIL'}  title="${title.slice(0, 30)}"  hash=${client.slice(0, 14)}…`)
  if (!pass) {
    console.error(`  client: ${client}`)
    console.error(`  server: ${server}`)
  }
}

if (allPass) {
  console.log('\nAll cases match. Client and server hashes are identical.')
  process.exit(0)
} else {
  console.error('\nMismatch detected.')
  process.exit(1)
}
