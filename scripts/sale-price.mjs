// Shared sale-pricing rules. Used by the cron (refresh-prod.mjs) and by the one-off
// historical backfill (reprice-sales.mjs) so the two can never drift apart.
//
// A marketplace transaction has two shapes and they need different arithmetic:
//
//   A. one buyer sweeps N listings and pays one lump sum
//      -> price per item = total / N
//   B. a Seaport bulk-fulfil batches N INDEPENDENT buyers, each paying for their own
//      listing in the same transaction
//      -> price per item = what that buyer paid, divided by that buyer's own items
//
// The old rule took the single largest WHYPE leg as the price of the whole tx and
// divided it evenly. That is right for A and badly wrong for B: tx 0x400ba80b… held
// three separate buyers paying 164.01 / 164.00 / 159.34 WHYPE and every one of the
// three tokens was recorded at 54.67.
//
// Attributing each WHYPE leg to its payer resolves both shapes with one rule.

export const DUST = 1; // HYPE floor: below this is a fee leg or a nominal, not a market sale

// legs: every NFT transfer in this tx, as {id, from, to, ...}
// tx:   {to, val}    from eth_getTransactionByHash
// legsPaid: [{from, amt}] every WHYPE Transfer in the receipt
export function priceForLeg(leg, legs, tx, whypeLegs, nftAddress) {
  if (!tx) return null;
  const nativeVal = Number(BigInt(tx.val || "0x0")) / 1e18;
  // Native HYPE is sent by the transaction signer, so there is exactly one payer:
  // shape A by construction. Split across every item in the tx.
  if (nativeVal > 0.001) return nativeVal / legs.length;
  // A direct call into the NFT contract is a transfer/claim, not a sale.
  if (tx.to === nftAddress) return null;
  const w = whypeLegs || [];
  const buyer = leg.to;
  const paid = w.filter(x => x.from === buyer).reduce((s, x) => s + x.amt, 0);
  if (paid > 0) {
    const mine = legs.filter(x => x.to === buyer).length || 1;
    return paid / mine;
  }
  // Buyer paid through an aggregator or router, so no leg is attributable to them.
  // Fall back to the old estimate rather than dropping a real sale on the floor.
  if (!w.length) return null;
  return Math.max(...w.map(x => x.amt)) / legs.length;
}

// True when the buyer's payment was attributable directly, i.e. not the fallback.
export function isAttributed(leg, tx, whypeLegs) {
  if (!tx) return false;
  if (Number(BigInt(tx.val || "0x0")) / 1e18 > 0.001) return true;
  return (whypeLegs || []).some(x => x.from === leg.to);
}
