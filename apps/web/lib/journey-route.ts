export const THUNDER_FINALE_THRESHOLD = 0.965;
export const THUNDER_HOLD_DURATION_MS = 2000;
export const THUNDER_HOLD_RESET_THRESHOLD = 0.9;
export const JOURNEY_ROUTE_MARKER_CLEARANCE = 17;

const scrollKeys = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

export const journeyBoltPolygon = [
  [116, 37],
  [322, 37],
  [241, 205],
  [298, 183],
  [232, 316],
  [341, 284],
  [104, 524],
  [174, 342],
  [66, 367],
  [140, 232],
  [69, 251],
] as const;

export const journeyBoltPath =
  "M116 37 322 37 241 205 298 183 232 316 341 284 104 524 174 342 66 367 140 232 69 251Z";

export const journeyRoutePoints = [
  { x: 163, y: 75 },
  { x: 222, y: 145 },
  { x: 190, y: 218 },
  { x: 200, y: 300 },
  { x: 195, y: 383 },
  { x: 158, y: 440 },
] as const;

export const journeyRouteSpine = journeyRoutePoints
  .map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
  .join(" ");

export type JourneyScrollState = {
  activeIndex: number;
  progress: number;
  displayProgress: number;
  isThunderFinale: boolean;
  isThunderHold: boolean;
};

type JourneyScrollTrackingOptions = {
  section: Pick<HTMLElement, "querySelector" | "querySelectorAll" | "style">;
  browser?: Pick<
    Window,
    | "addEventListener"
    | "cancelAnimationFrame"
    | "clearTimeout"
    | "document"
    | "innerHeight"
    | "matchMedia"
    | "removeEventListener"
    | "requestAnimationFrame"
    | "scrollTo"
    | "scrollY"
    | "setTimeout"
  >;
  onChange: (state: JourneyScrollState) => void;
};

export function normalizeJourneyProgress(progress: number): JourneyScrollState["progress"] {
  return Math.min(Math.max(progress, 0), 1);
}

export function resolveThunderProgress(progress: number) {
  const normalizedProgress = normalizeJourneyProgress(progress);
  const isThunderFinale = normalizedProgress >= THUNDER_FINALE_THRESHOLD;

  return {
    progress: normalizedProgress,
    displayProgress: isThunderFinale ? 1 : normalizedProgress,
    isThunderFinale,
  };
}

export function installJourneyScrollTracking({
  section,
  browser = window,
  onChange,
}: JourneyScrollTrackingOptions) {
  const articles = Array.from(section.querySelectorAll<HTMLElement>("[data-journey-step]"));
  let frame = 0;
  let holdActive = false;
  let holdArmed = true;
  let holdScrollY = 0;
  let holdTimer = 0;
  let latestState: JourneyScrollState | null = null;
  let previousScrollBehavior = "";
  let previousScrollBehaviorPriority = "";

  const preventScroll = (event: Event) => event.preventDefault();
  const preventKeyboardScroll = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      releaseHold();
      return;
    }

    const target = event.target as
      | (EventTarget & { isContentEditable?: boolean; tagName?: string })
      | null;
    const targetTagName = target?.tagName?.toUpperCase();
    const preservesNativeControlAction =
      target?.isContentEditable === true ||
      targetTagName === "INPUT" ||
      targetTagName === "TEXTAREA" ||
      targetTagName === "SELECT" ||
      (targetTagName === "BUTTON" && (event.key === " " || event.key === "Spacebar"));

    if (scrollKeys.has(event.key) && !preservesNativeControlAction) event.preventDefault();
  };

  const releaseHold = ({ emit = true }: { emit?: boolean } = {}) => {
    if (!holdActive) return;

    holdActive = false;
    if (holdTimer) browser.clearTimeout(holdTimer);
    holdTimer = 0;
    browser.removeEventListener("wheel", preventScroll);
    browser.removeEventListener("touchmove", preventScroll);
    browser.removeEventListener("keydown", preventKeyboardScroll);

    const rootStyle = browser.document.documentElement.style;
    if (previousScrollBehavior) {
      rootStyle.setProperty(
        "scroll-behavior",
        previousScrollBehavior,
        previousScrollBehaviorPriority,
      );
    } else {
      rootStyle.removeProperty("scroll-behavior");
    }

    if (emit) update();
  };

  const startHold = (targetScrollY: number) => {
    const rootStyle = browser.document.documentElement.style;
    holdActive = true;
    holdArmed = false;
    holdScrollY = targetScrollY;
    previousScrollBehavior = rootStyle.getPropertyValue("scroll-behavior");
    previousScrollBehaviorPriority = rootStyle.getPropertyPriority("scroll-behavior");
    rootStyle.setProperty("scroll-behavior", "auto", "important");
    browser.addEventListener("wheel", preventScroll, { passive: false });
    browser.addEventListener("touchmove", preventScroll, { passive: false });
    browser.addEventListener("keydown", preventKeyboardScroll);
    browser.scrollTo({ top: holdScrollY });
    holdTimer = browser.setTimeout(() => releaseHold(), THUNDER_HOLD_DURATION_MS);
  };

  const update = () => {
    const compactJourney = browser.matchMedia("(max-width: 860px)").matches;
    const stage = section.querySelector<HTMLElement>(".journey-stage");
    const stageBottom = stage?.getBoundingClientRect().bottom ?? 0;
    const mobileReadingLane = stageBottom + Math.max((browser.innerHeight - stageBottom) * 0.42, 32);
    const viewportAnchor = compactJourney
      ? Math.min(mobileReadingLane, browser.innerHeight - 32)
      : browser.innerHeight * 0.52;
    let activeIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    articles.forEach((article, articleIndex) => {
      const bounds = article.getBoundingClientRect();
      const distance = Math.abs(bounds.top + bounds.height / 2 - viewportAnchor);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        activeIndex = articleIndex;
      }
    });

    const firstBounds = articles[0]?.getBoundingClientRect();
    const lastBounds = articles.at(-1)?.getBoundingClientRect();
    const firstCenter = firstBounds ? firstBounds.top + firstBounds.height / 2 : viewportAnchor;
    const lastCenter = lastBounds ? lastBounds.top + lastBounds.height / 2 : viewportAnchor + 1;
    const progressRange = Math.max(lastCenter - firstCenter, 1);
    const rawProgress = (viewportAnchor - firstCenter) / progressRange;
    const thunderProgress = resolveThunderProgress(
      holdActive ? Math.max(rawProgress, THUNDER_FINALE_THRESHOLD) : rawProgress,
    );

    if (thunderProgress.progress < THUNDER_HOLD_RESET_THRESHOLD) holdArmed = true;
    if (holdArmed && thunderProgress.isThunderFinale) {
      const targetScrollY = Math.max(
        0,
        browser.scrollY + (THUNDER_FINALE_THRESHOLD - rawProgress) * progressRange,
      );
      startHold(targetScrollY);
    }

    section.style.setProperty("--journey-progress", `${thunderProgress.progress}`);
    latestState = { activeIndex, ...thunderProgress, isThunderHold: holdActive };
    onChange(latestState);
    frame = 0;
  };

  const schedule = () => {
    if (!frame) frame = browser.requestAnimationFrame(update);
  };

  const handleScroll = () => {
    if (holdActive) browser.scrollTo({ top: holdScrollY });
    schedule();
  };

  update();
  browser.addEventListener("scroll", handleScroll, { passive: true });
  browser.addEventListener("resize", schedule);

  return () => {
    releaseHold({ emit: false });
    if (frame) browser.cancelAnimationFrame(frame);
    browser.removeEventListener("scroll", handleScroll);
    browser.removeEventListener("resize", schedule);
  };
}
