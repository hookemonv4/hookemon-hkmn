"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import Image from "next/image";
import {
  HeroCollectorCards,
  JourneyCollectorCardViewport,
  type CollectorJourneyState,
} from "./CollectorCryptCards";
import {
  installJourneyScrollTracking,
  journeyBoltPath,
  journeyRoutePoints,
  journeyRouteSpine,
  type JourneyScrollState,
} from "../lib/journey-route";

export type JourneyStep = {
  id: string;
  number: string;
  title: string;
  copy: string;
  bubble: string;
  meta: string;
};

const guidePositions = [
  { x: 18, y: 15, rotate: -5 },
  { x: 58, y: 25, rotate: 4 },
  { x: 31, y: 39, rotate: -3 },
  { x: 61, y: 53, rotate: 5 },
  { x: 35, y: 67, rotate: -4 },
  { x: 60, y: 81, rotate: 2 },
];

const collectorJourneyStates = [
  "destination",
  "charging",
  "bridged",
  "opened",
  "buyback",
  "payout",
] as const satisfies readonly CollectorJourneyState[];

const particleColors = ["#ffcb05", "#2477bd", "#f33f8d", "#fff9ef"];

type Particle = {
  x: number;
  y: number;
  radius: number;
  speed: number;
  phase: number;
  color: string;
};

function useParticleField(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const pointerRef = useRef({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (!canvas || reduceMotion.matches) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let particles: Particle[] = [];

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(bounds.width, 1);
      height = Math.max(bounds.height, 1);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      particles = Array.from({ length: width < 700 ? 32 : 64 }, (_, index) => ({
        x: (index * 73.37) % width,
        y: (index * 47.11) % height,
        radius: 0.8 + (index % 4) * 0.45,
        speed: 0.12 + (index % 5) * 0.035,
        phase: index * 0.77,
        color: particleColors[index % particleColors.length],
      }));
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      const focusX = pointerRef.current.x * width;
      const focusY = pointerRef.current.y * height;

      particles.forEach((particle) => {
        const driftX = Math.sin(time * 0.00035 + particle.phase) * 17;
        const nextY = (particle.y - time * particle.speed * 0.02 + height * 4) % height;
        const dx = focusX - particle.x;
        const dy = focusY - nextY;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const pull = Math.max(0, 1 - distance / 260) * 24;
        const x = particle.x + driftX + (dx / distance) * pull;
        const y = nextY + (dy / distance) * pull;

        context.beginPath();
        context.fillStyle = particle.color;
        context.globalAlpha = 0.22 + Math.max(0, 1 - distance / 300) * 0.55;
        context.arc(x, y, particle.radius, 0, Math.PI * 2);
        context.fill();
      });

      context.globalAlpha = 1;
      frame = window.requestAnimationFrame(draw);
    };

    resize();
    frame = window.requestAnimationFrame(draw);
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef]);

  return pointerRef;
}

export function HookemonHeroVisual() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useParticleField(canvasRef);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1);
    pointerRef.current = { x, y };
    stageRef.current?.style.setProperty("--pointer-x", `${(x - 0.5) * 2}`);
    stageRef.current?.style.setProperty("--pointer-y", `${(y - 0.5) * 2}`);
  };

  const resetPointer = () => {
    pointerRef.current = { x: 0.5, y: 0.5 };
    stageRef.current?.style.setProperty("--pointer-x", "0");
    stageRef.current?.style.setProperty("--pointer-y", "0");
  };

  return (
    <div
      className="hero-visual pixel-panel"
      ref={stageRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetPointer}
      aria-label="Pikachu powers the Hookemon cycle with a scrolling Thunderbolt"
    >
      <span className="retro-screen-label">HOOKEMON // START</span>
      <canvas className="particle-field" ref={canvasRef} aria-hidden="true" />
      <div className="hero-energy-ring" aria-hidden="true" />
      <svg className="hero-bolt" viewBox="0 0 560 620" aria-hidden="true">
        <path d="M454 34 304 222h82l-166 164h92L116 586l80-174h-86l166-182h-82Z" />
      </svg>
      <HeroCollectorCards />
      <div className="hero-guide-character">
        <Image
          src="/pikachu-guide.png"
          width="587"
          height="710"
          alt="Your Pikachu guide to the Hookemon loop"
          priority
          unoptimized
        />
      </div>
      <div className="hero-speech retro-dialogue">
        <span>PIKA // GUIDE ONLINE</span>
        <strong>I&apos;ll show you where every swap goes.</strong>
      </div>
      <div className="hero-chain-pills" aria-hidden="true">
        <span>ETH</span>
        <i />
        <span>SOL</span>
        <i />
        <span>USDC</span>
      </div>
    </div>
  );
}

export function HookemonJourney({ steps }: { steps: JourneyStep[] }) {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useParticleField(canvasRef);
  const [journeyState, setJourneyState] = useState<JourneyScrollState>({
    activeIndex: 0,
    progress: 0,
    displayProgress: 0,
    isThunderFinale: false,
    isThunderHold: false,
  });
  const { activeIndex, displayProgress, isThunderFinale, isThunderHold, progress: journeyProgress } =
    journeyState;
  const activeStep = steps[activeIndex] ?? steps[0];
  const collectorState = collectorJourneyStates[activeIndex] ?? collectorJourneyStates[0];
  const position = guidePositions[activeIndex] ?? guidePositions[0];

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    return installJourneyScrollTracking({
      section,
      onChange: (nextState) => {
        setJourneyState((currentState) =>
          currentState.activeIndex === nextState.activeIndex &&
          Math.abs(currentState.progress - nextState.progress) < 0.001 &&
          currentState.isThunderFinale === nextState.isThunderFinale &&
          currentState.isThunderHold === nextState.isThunderHold
            ? currentState
            : nextState,
        );
      },
    });
  }, [steps.length]);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerRef.current = {
      x: Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1),
      y: Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1),
    };
  };

  const guideStyle = {
    "--guide-x": `${position.x}%`,
    "--guide-y": `${position.y}%`,
    "--guide-rotate": `${position.rotate}deg`,
    "--bolt-progress": `${journeyProgress}`,
    "--journey-progress": `${journeyProgress}`,
  } as CSSProperties;

  return (
    <section
      className="journey-section"
      id="how-it-works"
      aria-label="Hookemon cycle journey"
      ref={sectionRef}
      data-active-step={activeIndex + 1}
      data-thunder-finale={isThunderFinale ? "active" : "idle"}
      data-thunder-hold={isThunderHold ? "active" : "idle"}
      data-route-era="hoenn-2002-2006"
      data-collector-state={collectorState}
    >
      <div className="journey-intro section-shell" data-reveal="up">
        <div>
          <span className="section-kicker">FOLLOW THE THUNDERBOLT</span>
          <h2>Six stops. One visible loop</h2>
        </div>
        <p>
          Pikachu follows the money from an Ethereum swap to a sponsored USDC payout. Scroll to
          charge every stage.
        </p>
      </div>

      <div className="journey-layout section-shell">
        <div
          className="journey-stage retro-map pixel-panel hoenn-route-map"
          style={guideStyle}
          onPointerMove={handlePointerMove}
        >
          <canvas className="particle-field" ref={canvasRef} aria-hidden="true" />
          <div className="journey-stage-top">
            <span>THUNDER ROUTE // SIMULATOR</span>
            <span>CHARGE {Math.round(displayProgress * 100)}%</span>
          </div>

          <JourneyCollectorCardViewport state={collectorState} />

          <div className="journey-hook-fee" aria-label="3% Hook fee from the Ethereum swap">
            <span>HOOK FEE</span>
            <strong>3%</strong>
            <small>ETH SWAP</small>
          </div>

          <div className="journey-mobile-speech retro-dialogue" aria-live="polite">
            <span>PIKACHU SAYS</span>
            <strong>{activeStep?.bubble}</strong>
          </div>

          <svg
            className="journey-bolt-filled"
            viewBox="0 0 430 560"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="journey-bolt-gold" x1="0" y1="0" x2="0.78" y2="1">
                <stop offset="0" stopColor="#fff45d" />
                <stop offset="0.52" stopColor="#ffcb05" />
                <stop offset="1" stopColor="#f39a13" />
              </linearGradient>
              <clipPath id="journey-bolt-charge-clip">
                <rect
                  className="journey-bolt-charge-mask"
                  x="0"
                  y="0"
                  width="430"
                  height="560"
                />
              </clipPath>
            </defs>
            <path className="journey-bolt-outline journey-bolt-outline-outer" d={journeyBoltPath} />
            <path className="journey-bolt-outline journey-bolt-outline-halo" d={journeyBoltPath} />
            <path className="journey-bolt-body" d={journeyBoltPath} />
            <path
              className="journey-bolt-charge"
              clipPath="url(#journey-bolt-charge-clip)"
              d={journeyBoltPath}
            />
            <path className="journey-route-spine" d={journeyRouteSpine} />
            {steps.map((step, index) => {
              const point = journeyRoutePoints[index] ?? journeyRoutePoints[0];
              const routeState =
                index === activeIndex ? " is-active" : index < activeIndex ? " is-charged" : "";

              return (
                <g
                  className={`journey-route-point${routeState}`}
                  data-route-point="true"
                  key={step.id}
                  transform={`translate(${point.x} ${point.y})`}
                >
                  <circle r="15" />
                  <text x="0" y="1">
                    {step.number}
                  </text>
                </g>
              );
            })}
          </svg>

          <div className="journey-thunder-scene" aria-hidden="true">
            <strong className="journey-thunder-title">
              THUNDER
              <br />
              RELEASE!
            </strong>
            <div className="journey-thunder-artwork">
              <Image
                src="/pikachu-thunder-release.png"
                width="982"
                height="602"
                alt=""
                unoptimized
              />
            </div>
            <span className="journey-thunder-status">100% // FULL DISCHARGE</span>
          </div>

          <div className="journey-guide" aria-hidden="true">
            <div className="journey-guide-motion" key={activeStep?.id}>
              <div className="journey-speech retro-dialogue">
                <span>PIKACHU SAYS</span>
                <strong>{activeStep?.bubble}</strong>
              </div>
              <div className="journey-guide-character">
                <Image src="/pikachu-guide.png" width="587" height="710" alt="" unoptimized />
              </div>
            </div>
          </div>

          <div className="journey-active-label" aria-live="polite">
            <span>{activeStep?.meta}</span>
            <strong>{activeStep?.title}</strong>
            <p className="journey-active-copy">{activeStep?.copy}</p>
            <div className="journey-progress-dots" aria-hidden="true">
              {steps.map((step, index) => (
                <span
                  className={`journey-progress-dot${
                    index === activeIndex ? " is-active" : index < activeIndex ? " is-charged" : ""
                  }`}
                  key={step.id}
                >
                  {step.number}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="journey-copy">
          {steps.map((step, index) => (
            <article
              className={
                index === activeIndex
                  ? "journey-step quest-panel is-active"
                  : "journey-step quest-panel"
              }
              data-journey-step
              key={step.id}
            >
              <div className="journey-step-head">
                <span>{step.number}</span>
                <span>{step.meta}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
              <div className="journey-step-charge" aria-hidden="true">
                <span />
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
