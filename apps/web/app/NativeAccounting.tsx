import { formatNativeAmount } from "../lib/native-accounting.mjs";
import styles from "./PublicCycleTracker.module.css";

export default function NativeAccounting({ accounting }: { accounting: unknown }) {
  if (!accounting || typeof accounting !== "object" || !("schema" in accounting) || accounting.schema !== "hookemon.native-round-accounting.v1") return null;
  const source = accounting as Record<string, unknown>;
  const scalar = (key: string, decimals = 18, unit = "ETH") => formatNativeAmount(source[key] as string | null, decimals, unit);
  const typed = (key: string) => {
    const amount = source[key] as { units: string; decimals: number; assetId: string; chainId: string } | null;
    if (!amount) return "Not confirmed";
    const unit = amount.chainId === "4663" && amount.assetId === "native" && amount.decimals === 18 ? "ETH" : amount.assetId;
    return formatNativeAmount(amount.units, amount.decimals, unit);
  };
  const entries = [
    ["Cycle principal", typed("releaseAmount")],
    ["Outbound bridge", typed("outboundBridgeDebit")],
    ["Returned principal", typed("inboundBridgeProceeds")],
    ["Collector purchase", typed("collectorPurchaseDebit")],
    ["Collector buyback", typed("collectorBuybackProceeds")],
    ["Holder rewards paid", scalar("paidHolderRewardsWei")],
    ["Outstanding payouts", scalar("payoutLiabilityWei")],
    ["Retained dust", scalar("payoutDustWei")],
    ["Pack spend valuation", scalar("packSpendMicroUsd", 6, "USD")],
    ["Buyback valuation", scalar("buybackMicroUsd", 6, "USD")],
  ];
  return <dl className={styles.primaryMetrics} aria-label="Native ETH cycle accounting">
    {entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}
