import { HookemonHeroVisual, HookemonJourney, type JourneyStep } from "./HookemonJourney";
import Image from "next/image";
import { CollectorCardsProvider } from "./CollectorCryptCards";
import PublicCycleTracker, {
  PublicCycleCardRail,
  PublicDeploymentDisclosure,
  PublicCycleHeaderStatus,
  PublicCycleProvider,
} from "./PublicCycleTracker";
import trackerStyles from "./PublicCycleTracker.module.css";
import HeroDashboard from "./HeroDashboard";
import RevealManager from "./RevealManager";
import CardShowcase3D from "./CardShowcase3D";
import { GITHUB_REPO_URL, SocialLinks } from "./SocialLinks";

const journeySteps = [
  {
    id: "swap",
    number: "01",
    title: "Swap on Ethereum",
    copy: "The protocol design routes HOOKEMON / USDC swaps through one immutable Uniswap v4 hook.",
    bubble: "Every swap starts the machine.",
    meta: "ETH · V4",
  },
  {
    id: "split",
    number: "02",
    title: "Split the 3%",
    copy: "0.1% is reserved for Programmable, 0.4% goes to the fixed Treasury wallet, and 2.5% enters the pack engine.",
    bubble: "Three percent becomes fuel.",
    meta: "0.1 + 0.4 + 2.5",
  },
  {
    id: "bridge",
    number: "03",
    title: "Bridge to Solana",
    copy: "Collected USDC moves in bounded batches instead of paying for a bridge on every trade.",
    bubble: "We batch the trip to Solana.",
    meta: "USDC · CCTP",
  },
  {
    number: "04",
    id: "open",
    title: "Open digital packs",
    copy: "The policy selects available Collector Crypt Gacha packs from price, stock, floor and buyback data.",
    bubble: "Volume chooses the pack lane.",
    meta: "SOL · GACHA",
  },
  {
    id: "sell",
    number: "05",
    title: "Sell every hit",
    copy: "Turbo buybacks resolve instantly; other eligible cards are sold inside their buyback window.",
    bubble: "Every eligible hit returns to USDC.",
    meta: "NFT → USDC",
  },
  {
    id: "pay",
    number: "06",
    title: "Pay holders automatically",
    copy: "Returned USDC bridges home and the operator sponsors proportional payouts to eligible time-weighted holders.",
    bubble: "No claim. USDC comes to you.",
    meta: "AUTO · TOP 200",
  },
] satisfies JourneyStep[];

const stats = [
  ["3.0%", "Hook fee"],
  ["Top 200", "Time-weighted"],
  ["20 min", "Accounting cycle"],
  ["No claim", "Automatic USDC"],
];

export default function Home() {
  return (
    <main data-visual-theme="hoenn-gacha">
      <CollectorCardsProvider>
      <PublicCycleProvider>
      <RevealManager />
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Hookemon home">
          <span className="brand-mark" aria-hidden="true">
            <Image
              src="/hookemon-mark.webp"
              width="1254"
              height="1254"
              alt=""
              priority
              unoptimized
            />
          </span>
          <span className="brand-wordmark" aria-hidden="true">
            <Image
              src="/hookemon-banner.webp"
              width="1500"
              height="500"
              alt=""
              priority
              unoptimized
            />
          </span>
        </a>
        <nav aria-label="Primary">
          <a href="#how-it-works">The loop</a>
          <a href="#live-machine">Machine</a>
          <a href="#economics">Economics</a>
          <a href="#risks">Risks</a>
        </nav>
        <div className={trackerStyles.headerActions}>
          <PublicCycleHeaderStatus />
          <SocialLinks />
        </div>
      </header>

      <PublicCycleTracker />
      <PublicCycleCardRail />

      <section className="hero section-shell" id="top">
        <div className="hero-copy">
          <div className="retro-hud" aria-label="Protocol status">
            <span>PLAYER 01</span>
            <span>ETH ↔ SOL</span>
            <span>3% POWER</span>
          </div>
          <div className="eyebrow-row">
            <span className="status-chip">
              <span className="status-dot" aria-hidden="true" /> <PublicDeploymentDisclosure />
            </span>
            <span className="chain-label">ETHEREUM ↔ SOLANA</span>
          </div>
          <h1 data-parallax="slow">
            <span>THE CYCLE</span>
            <span className="accent-line">NEVER STOPS</span>
          </h1>
          <p className="hero-lede">
            Hookemon uses Ethereum swap fees to open Collector Crypt Pok&eacute;mon Gacha packs and
            automatically routes instant buyback USDC proceeds to eligible holders.
          </p>
          <div className="hero-manifesto" aria-label="Hookemon promise">
            <span>SWAPS RIP PACKS.</span>
            <span>HITS PAY HOLDERS.</span>
          </div>
          <div className="hero-actions">
            <a className="primary-action retro-button" href="#how-it-works">
              Enter the loop <span aria-hidden="true">↓</span>
            </a>
            <a
              className="secondary-action retro-button"
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              Read the open source code
            </a>
            <SocialLinks className="social-links hero-social-links" />
          </div>
          <p className="release-note">
            <PublicDeploymentDisclosure /> Displayed Collector Crypt inventory is product evidence,
            not a guaranteed reward. It is not a completed Hookemon pull. No audit, approval, or
            sale availability claim is being made.
          </p>
        </div>

        <div className="hero-side" data-reveal="right">
          <HeroDashboard />
          <HookemonHeroVisual />
        </div>
      </section>

      <section className="stat-strip" aria-label="Protocol headline statistics">
        {stats.map(([value, label], index) => (
          <div
            key={value}
            data-reveal="up"
            style={{ "--reveal-delay": `${index * 0.08}s` } as React.CSSProperties}
          >
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>

      <HookemonJourney steps={journeySteps} />

      <CardShowcase3D />

      <section className="economics-section section-shell" id="economics">
        <div className="section-heading compact-heading" data-reveal="tilt">
          <div>
            <span className="section-kicker">THE MATH</span>
            <h2>Simple on the surface. Strict underneath</h2>
          </div>
        </div>
        <div className="economics-grid inventory-menu">
          <article className="fee-panel" data-reveal="left">
            <span className="panel-label fee-flow-label">SWAP + INCLUSIVE HOOK FEE</span>
            <div className="fee-flow">
              <section
                className="fee-composition"
                aria-label="100 percent swap amount: 97 percent continues to swap and 3 percent is the inclusive Hook fee"
              >
                <div className="fee-composition-heading">
                  <span>100% SWAP AMOUNT</span>
                  <strong>100%</strong>
                </div>
                <div className="fee-composition-bar swap-composition-bar" aria-hidden="true">
                  <span className="swap-remainder-bar" />
                  <span className="swap-hook-bar" />
                </div>
                <div className="fee-value-grid">
                  <div className="fee-value-card swap-remainder-card">
                    <strong>97%</strong>
                    <span>CONTINUES TO SWAP</span>
                  </div>
                  <div className="fee-value-card swap-hook-card">
                    <strong>3%</strong>
                    <span>INCLUSIVE HOOK FEE</span>
                  </div>
                </div>
                <p>97% of the swap amount continues into the pool swap.</p>
              </section>
              <section
                className="fee-composition"
                aria-label="3 percent Hook fee: 0.1 percent Programmable, 0.4 percent Treasury, and 2.5 percent pack engine"
              >
                <div className="fee-composition-heading">
                  <span>3% HOOK FEE</span>
                  <strong>3%</strong>
                </div>
                <div className="fee-composition-bar hook-composition-bar" aria-hidden="true">
                  <span className="programmable-bar" />
                  <span className="treasury-bar" />
                  <span className="project-bar" />
                </div>
                <div className="fee-value-grid">
                  <div className="fee-value-card programmable-card">
                    <strong>0.1%</strong>
                    <span>Programmable</span>
                  </div>
                  <div className="fee-value-card treasury-card">
                    <strong>0.4%</strong>
                    <span>Treasury</span>
                  </div>
                  <div className="fee-value-card project-card">
                    <strong>2.5%</strong>
                    <span>Pack engine</span>
                  </div>
                </div>
              </section>
            </div>
            <p className="fee-footnote">
              Liquidity-provider fees are separate and disclosed by the pool.
            </p>
          </article>

          <article className="strategy-panel" data-reveal="right">
            <span className="panel-label">DYNAMIC PACK POLICY</span>
            <div className="strategy-row">
              <div className="strategy-number lime-text">75%</div>
              <div>
                <h3>Core lane</h3>
                <p>Prioritizes the strongest live instant-buyback floor per dollar.</p>
              </div>
            </div>
            <div className="strategy-row">
              <div className="strategy-number cyan-text">25%</div>
              <div>
                <h3>Showcase lane</h3>
                <p>Accumulates for higher-upside machines when volume can support them.</p>
              </div>
            </div>
            <div className="strategy-rule">
              <span>HARD RULE</span>
              Maximum 20 packs per decision window. Stale data means zero buys.
            </div>
          </article>
        </div>
      </section>

      <section className="payout-section section-shell">
        <div className="payout-card payout-menu" data-reveal="up">
          <div className="payout-copy">
            <span className="section-kicker">ZERO-CLICK REWARDS</span>
            <h2>Your wallet receives. You do nothing</h2>
            <p>
              Hookemon closes accounting every 20 minutes, ranks direct holders by time-weighted
              balance, and accrues returned USDC proportionally. The operator pays eligible wallets
              in sponsored batches.
            </p>
            <ul>
              <li>No claim transaction</li>
              <li>No holder gas</li>
              <li>No reward expiry or forfeiture</li>
              <li>Small balances roll forward</li>
            </ul>
          </div>
          <div
            className="wallet-visual"
            aria-label="Example automatic reward payment"
            data-parallax="medium"
          >
            <div className="wallet-top">
              <span>WALLET // 0x71…A9F2</span>
              <span>RANK #018</span>
            </div>
            <div className="wallet-balance">
              <span>AUTOMATIC REWARD</span>
              <strong>+12.84 USDC</strong>
            </div>
            <div className="wallet-status-row">
              <span className="check-mark" aria-hidden="true" />
              <div>
                <strong>Paid by protocol</strong>
                <span>Holder action: none</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="risk-section section-shell system-warning" id="risks">
        <div className="risk-heading" data-reveal="tilt">
          <span className="section-kicker">READ BEFORE THE MEME</span>
          <h2>Open source does not mean risk free</h2>
        </div>
        <div className="risk-grid">
          <article data-reveal="up">
            <span>01</span>
            <h3>Verify deployment status</h3>
            <p><PublicDeploymentDisclosure /></p>
          </article>
          <article data-reveal="up" style={{ "--reveal-delay": "0.08s" } as React.CSSProperties}>
            <span>02</span>
            <h3>Pack outcomes vary</h3>
            <p>Gacha returns are uncertain. Holder rewards are never promised or guaranteed.</p>
          </article>
          <article data-reveal="up" style={{ "--reveal-delay": "0.16s" } as React.CSSProperties}>
            <span>03</span>
            <h3>Cross-chain dependency</h3>
            <p>Circle, Ethereum, Solana and Collector Crypt can pause, fail, or change behavior.</p>
          </article>
          <article data-reveal="up" style={{ "--reveal-delay": "0.24s" } as React.CSSProperties}>
            <span>04</span>
            <h3>Memecoins are extreme risk</h3>
            <p>Token value can fall to zero. Never treat Hookemon as savings or guaranteed yield.</p>
          </article>
        </div>
      </section>

      <section className="closing-section section-shell retro-closing" data-reveal="scale">
        <div className="closing-wordmark" role="img" aria-label="Hookemon V4">
          <Image
            className="closing-mark"
            src="/hookemon-mark.webp"
            width="1254"
            height="1254"
            alt=""
            loading="lazy"
            unoptimized
          />
          <Image
            className="closing-type"
            src="/hookemon-banner.webp"
            width="1500"
            height="500"
            alt=""
            loading="lazy"
            unoptimized
          />
        </div>
        <span className="section-kicker">BUILD IN PUBLIC</span>
        <h2>Follow every hook, bridge, pack and payout</h2>
        <p>The dashboard code and its passing tests are public. <PublicDeploymentDisclosure /></p>
        <a
          className="primary-action retro-button"
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noreferrer"
        >
          Explore the repository <span aria-hidden="true">↗</span>
        </a>
        <SocialLinks className="social-links closing-social-links" />
      </section>

      <footer className="retro-footer">
        <div className="footer-brand">
          <span className="brand-mark" aria-hidden="true">
            <Image
              src="/hookemon-mark.webp"
              width="1254"
              height="1254"
              alt=""
              loading="lazy"
              unoptimized
            />
          </span>
          <div className="footer-brand-lockup">
            <span className="brand-wordmark">
              <Image
                src="/hookemon-banner.webp"
                width="1500"
                height="500"
                alt="Hookemon V4"
                loading="lazy"
                unoptimized
              />
            </span>
            <span>V4 GACHA REWARD LOOP</span>
          </div>
        </div>
        <p>
          Not affiliated with Nintendo, The Pokémon Company, Game Freak, or Collector Crypt. Pokémon
          names and trademarks belong to their respective owners.
        </p>
        <span>PROTOTYPE // 2026</span>
      </footer>
      </PublicCycleProvider>
      </CollectorCardsProvider>
    </main>
  );
}
