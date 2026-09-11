/**
 * POST /api/links/:linkId/wallet — mint the wallet a link is driven by.
 *
 * WHY THIS EXISTS
 * Round-3 review, B1: nothing in production ever called `createLinkWallet`. The
 * key that `linkOps` unwraps to sign every payment was written only by tests, so
 * on a real deployment `linkSigner` returned null and every payment answered
 * "This payment link is no longer active." Separately, the merchant had no way
 * to obtain the account address `registerAgent` requires — it is generated
 * inside `createLinkWallet` and returned only to its caller.
 *
 * This is that caller.
 *
 * THE ORDERING THE MERCHANT APP MUST FOLLOW
 *   1. POST here with the linkId  →  returns the account address
 *   2. batch, IN THIS ORDER:
 *        integrator.createLink(linkId, …)
 *        router.registerAgent(linkId, account)
 *
 * `registerAgent` reads `getLink` to check ownership, so `createLink` has to
 * land first WITHIN the batch. Reversed, the batch reverts on a link that does
 * not exist yet — which at least fails loudly, unlike omitting step 2 entirely.
 *
 * WHY THE ADDRESS IS MINTED BEFORE THE LINK EXISTS
 * Because the batch needs it before it is signed. That means ownership cannot
 * be checked against `link.owner` — the link is not there yet. So:
 *
 *   • the signer must ALWAYS be a registered, non-frozen merchant
 *   • AND, if the link already exists, its owner
 *
 * Both, not either. See `authorise` for why the order of those two reads
 * matters more than it looks.
 */

import { type Address, type Hex } from "viem";
import { publicClientFor } from "./chain";
import { INTEGRATOR_ABI, type Env } from "./config";
import { createLinkWallet, linkWalletAddress, keyTtlFor, mintedBy } from "./linkWallet";
import { predictAccount } from "./aa";
import { json, badRequest, isHex32, normalizeLinkId } from "./http";

/** How long a provisioning signature stays valid. */
export const PROVISION_WINDOW_SECONDS = 300;

/**
 * Wallets one merchant may mint per hour (round-4 L7).
 *
 * Set well above genuine use — a merchant creating a batch of links for a
 * catalogue is normal, and refusing that is a worse failure than the abuse this
 * bounds. It exists to cap the blast radius of a stolen merchant key, not to
 * shape ordinary behaviour.
 */
export const MAX_PROVISIONS_PER_MERCHANT_HOUR = 100;

/**
 * Fixed-window counter, keyed on the merchant.
 *
 * Approximate for the same reason `limits.ts` documents: KV is eventually
 * consistent, so a concurrent burst can slip past the line before the window
 * catches up. Acceptable here — this is a blast-radius cap, and the authoritative
 * limits on what a link can do are on-chain.
 */
async function bumpProvisionCount(env: Env, merchant: Address): Promise<number> {
  const key = `rl:provision:${merchant.toLowerCase()}:${Math.floor(Date.now() / 3_600_000)}`;
  const n = Number((await env.KV.get(key)) ?? "0") + 1;
  await env.KV.put(key, String(n), { expirationTtl: 7200 });
  return n;
}

interface ProvisionBody {
  signer?: string;
  signature?: string;
  expiry?: number;
}

const MERCHANT_INFO_ABI = [
  {
    type: "function",
    name: "getMerchantInfo",
    stateMutability: "view",
    inputs: [{ name: "merchant", type: "address" }],
    outputs: [
      { name: "encPayoutId", type: "bytes" },
      { name: "shopName", type: "string" },
      { name: "currency", type: "bytes32" },
      { name: "isRegistered", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;

/**
 * Verifies the merchant signed THIS request, for THIS link.
 *
 * The linkId is inside the signature. Without it a captured signature would
 * mint a wallet for any link the holder named — and since the address is what
 * gets bound on-chain, that is the whole authorisation.
 *
 * `signer` IS THE MERCHANT ACCOUNT, NOT THE KEY THAT SIGNED
 * In production the merchant is a smart account: a social login controls an
 * owner key, but the address registered as a merchant, and recorded as
 * `link.owner`, is the ACCOUNT. Recovering the signature to an EOA and looking
 * that up finds no merchant, so every real merchant is refused — which is
 * exactly what happened, and only surfaced once a test used a smart account
 * instead of an EOA.
 *
 * So verification goes through the PUBLIC CLIENT rather than the standalone
 * helper. For a contract it asks the account itself, via ERC-1271; for an EOA
 * it does ordinary recovery. Both shapes work, and the address checked is the
 * one the contract will actually compare against.
 */
async function verifyMerchant(
  env: Env,
  linkId: string,
  body: ProvisionBody
): Promise<Address | null> {
  const { signer, signature, expiry } = body;
  if (!signer || !signature || typeof expiry !== "number") return null;

  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now || expiry > now + PROVISION_WINDOW_SECONDS) return null;

  try {
    const ok = await publicClientFor(env).verifyTypedData({
      address: signer as Address,
      // Bound to this chain and this integrator, so a signature from a testnet
      // deployment is not a signature here.
      domain: {
        name: "P2P Merchant Terminal Admin",
        version: "1",
        chainId: Number(env.CHAIN_ID),
        verifyingContract: env.INTEGRATOR_ADDRESS as Address,
      },
      types: {
        LinkWallet: [
          { name: "linkId", type: "bytes32" },
          { name: "expiry", type: "uint256" },
        ],
      },
      primaryType: "LinkWallet",
      message: { linkId: linkId as Hex, expiry: BigInt(expiry) },
      signature: signature as Hex,
    });
    return ok ? (signer as Address) : null;
  } catch {
    return null;
  }
}

/**
 * Is this signer allowed to mint a wallet for this link?
 *
 * Two checks, in this order, and the order is the point:
 *
 *   1. The signer must be a REGISTERED, NON-FROZEN merchant. Always. A frozen
 *      merchant cannot take payments, so minting them a wallet only creates
 *      something that fails later, after a customer has engaged with it.
 *
 *   2. If the link ALREADY exists, the signer must be its owner.
 *
 * Doing the merchant read FIRST also settles a question the naive version got
 * wrong. `getLink` reverts `LinkNotFound` for a link that does not exist yet —
 * the normal case here, since the address is needed before the batch — but it
 * also throws when the RPC is simply unreachable. An earlier version caught
 * both and fell through to the weaker check, so an RPC blip on someone else's
 * existing link let a different merchant mint for it. They could not then
 * `registerAgent` (the Router checks the owner), but they occupied the record,
 * and the real owner's link id was dead.
 *
 * A successful merchant read proves the RPC is answering. Only then is a
 * `getLink` failure attributable to the link not existing.
 *
 * Returns the link's expiry when allowed, since that sizes the key's lifetime.
 */
async function authorise(
  env: Env,
  linkId: string,
  signer: Address
): Promise<{ ok: true; expiresAt: bigint } | { ok: false }> {
  const client = publicClientFor(env);

  // 1 ── Merchant status. This read also proves the RPC is answering, which is
  //      what makes the getLink failure below interpretable.
  try {
    const info = (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: MERCHANT_INFO_ABI,
      functionName: "getMerchantInfo",
      args: [signer],
    })) as readonly [Hex, string, Hex, boolean, boolean];

    const registered = info[3];
    const frozen = info[4];
    if (!registered || frozen) return { ok: false };
  } catch {
    // Unreadable chain. Refuse rather than fall back to something weaker — an
    // RPC outage must not widen who may mint.
    return { ok: false };
  }

  // 2 ── Ownership, when there is a link to own.
  try {
    const link = (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [linkId as Hex],
    })) as readonly [Address, bigint, Hex, bigint, number, number, number, number];

    if (link[0].toLowerCase() !== signer.toLowerCase()) return { ok: false };
    return { ok: true, expiresAt: link[3] };
  } catch {
    // The RPC answered a moment ago, so this is LinkNotFound: the link has not
    // been created yet, which is exactly why the merchant is here.
    //
    // Its expiry is therefore unknown and the key is created without one. That
    // is deliberate — a key that outlived its link would strand it forever,
    // since `registerAgent` is write-once (see `keyTtlFor`). The cost is a
    // record that outlives a short-lived link; revoking the link deletes it.
    return { ok: true, expiresAt: 0n };
  }
}

/**
 * Mints, or returns, the link's wallet address.
 *
 * IDEMPOTENT. The merchant app may retry after a dropped response, and a second
 * mint would produce a different address — which `registerAgent`, being
 * write-once, would then refuse forever. So an existing record is returned
 * as-is, provided the same merchant is asking.
 */
export async function handleProvisionWallet(
  req: Request,
  env: Env,
  rawLinkId: string
): Promise<Response> {
  const linkId = normalizeLinkId(rawLinkId);
  if (!isHex32(linkId)) return badRequest("That payment link address is not valid.");

  const body = (await req.json().catch(() => ({}))) as ProvisionBody;

  const signer = await verifyMerchant(env, linkId, body);
  // The same answer for a bad signature and for an unauthorised signer —
  // distinguishing them tells a prober which half to work on.
  if (!signer) return json({ error: "Not authorised." }, 403);

  const existingOwner = await mintedBy(env, linkId);
  if (existingOwner) {
    if (existingOwner.toLowerCase() !== signer.toLowerCase()) {
      // Someone else already minted for this link id. Refusing rather than
      // overwriting: overwriting would strand whatever they registered, and
      // link ids are merchant-derived so a genuine collision is not expected.
      return json({ error: "This link id is already in use." }, 409);
    }
    const account = await linkWalletAddress(env, linkId);
    if (account) return json({ linkId, account, existing: true });
    // A record whose address is unreadable is worse than none — fall through
    // and mint again rather than hand back nothing.
  }

  const allowed = await authorise(env, linkId, signer);
  if (!allowed.ok) return json({ error: "Not authorised." }, 403);

  // ROUND-4 L7. Rate limited on the MERCHANT, not the IP, because the route is
  // signature-gated — an IP bucket would be the wrong axis entirely, since one
  // merchant behind a rotating address is the case that matters and many
  // merchants behind one carrier NAT is the case that must not be punished.
  //
  // Bounded because a mint is not free: two RPC reads, and since round-3 M1
  // removed the key TTL cap, a link with `expiresAt = 0` writes a KV record
  // with NO expiry at all. One compromised or careless merchant key could
  // otherwise write unbounded permanent records. Deliberately loose — a real
  // merchant creating links in a burst must not be blocked.
  const minted = await bumpProvisionCount(env, signer);
  if (minted > MAX_PROVISIONS_PER_MERCHANT_HOUR) {
    return json({ error: "Too many links created. Please wait a few minutes." }, 429);
  }

  const ttl = keyTtlFor(allowed.expiresAt);
  // ROUND-4 L6. `null` means the link has already expired. Refuse: an expired
  // link cannot be paid, so the wallet would be unusable the moment it existed
  // — and passing the old `0` into KV threw from inside `put`, which before the
  // error boundary in `index.ts` reached the caller as an opaque 500 with no
  // CORS headers.
  if (ttl === null) {
    return json({ error: "This payment link has already expired." }, 410);
  }

  const account = await createLinkWallet(
    env,
    linkId,
    ttl,
    (owner) => predictAccount(env, owner),
    signer
  );

  return json({
    linkId,
    account,
    existing: false,
    // Stated in the response because getting it wrong is silent: reversed, the
    // batch reverts; omitted, the link looks correct and can never be paid.
    next: "batch createLink(linkId, …) then registerAgent(linkId, account), in that order",
  });
}
