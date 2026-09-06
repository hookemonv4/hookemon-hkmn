"use client";

import Image from "next/image";
import { useRef, type PointerEvent } from "react";

type ShowcaseCard = {
  id: string;
  name: string;
  element: string;
  image: string;
  accent: string;
};

const showcaseCards: ShowcaseCard[] = [
  {
    id: "volt-sprite",
    name: "Volt Sprite",
    element: "STORM",
    image: "/showcase/volt-sprite.webp",
    accent: "#ffcb05",
  },
  {
    id: "tide-hatchling",
    name: "Tide Hatchling",
    element: "DEEP SEA",
    image: "/showcase/tide-hatchling.webp",
    accent: "#39c5ce",
  },
  {
    id: "ember-chick",
    name: "Ember Chick",
    element: "MAGMA",
    image: "/showcase/ember-chick.webp",
    accent: "#f3703f",
  },
];

function handleTilt(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const bounds = card.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - 0.5;
  const y = (event.clientY - bounds.top) / bounds.height - 0.5;
  card.style.setProperty("--tilt-x", `${(-y * 16).toFixed(2)}deg`);
  card.style.setProperty("--tilt-y", `${(x * 20).toFixed(2)}deg`);
  card.style.setProperty("--shine-x", `${((x + 0.5) * 100).toFixed(1)}%`);
  card.style.setProperty("--shine-y", `${((y + 0.5) * 100).toFixed(1)}%`);
}

function resetTilt(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  card.style.setProperty("--tilt-x", "0deg");
  card.style.setProperty("--tilt-y", "0deg");
}

export default function CardShowcase3D() {
  const sectionRef = useRef<HTMLElement>(null);

  return (
    <section
      className="card-showcase section-shell"
      id="card-showcase"
      ref={sectionRef}
      aria-label="Stylized collector card showcase"
    >
      <div className="section-heading compact-heading" data-reveal="tilt">
        <div>
          <span className="section-kicker">HOLO VAULT</span>
          <h2>Cards worth chasing. Rendered in 3D</h2>
        </div>
      </div>
      <div className="card-showcase-grid">
        {showcaseCards.map((card, index) => (
          <figure
            className="card-showcase-card"
            key={card.id}
            data-reveal="up"
            data-parallax={index === 1 ? "slow" : "medium"}
            style={
              {
                "--card-accent": card.accent,
                "--reveal-delay": `${index * 0.12}s`,
              } as React.CSSProperties
            }
            onPointerMove={handleTilt}
            onPointerLeave={resetTilt}
          >
            <div className="card-showcase-inner">
              <Image
                src={card.image}
                width="896"
                height="1216"
                alt={`${card.name}, an original stylized gacha creature card`}
                loading="lazy"
                unoptimized
              />
              <span className="card-showcase-shine" aria-hidden="true" />
              <figcaption>
                <strong>{card.name}</strong>
                <span>{card.element}</span>
              </figcaption>
            </div>
          </figure>
        ))}
      </div>
      <p className="card-showcase-note" data-reveal="up">
        Illustrative original artwork in the spirit of Collector Crypt Gacha pulls. It is not
        Collector Crypt inventory, not a completed Hookemon pull, and not a guaranteed reward.
      </p>
    </section>
  );
}
