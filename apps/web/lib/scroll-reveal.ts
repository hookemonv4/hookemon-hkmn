export const REVEALED_CLASS = "is-revealed";

type RevealTarget = {
  dataset: { reveal?: string };
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
  };
};

type RevealRoot = {
  querySelectorAll: (selector: string) => Iterable<RevealTarget>;
};

type ObserveElement = (
  element: RevealTarget,
  onVisibilityChange: (visible: boolean) => void,
) => () => void;

export type RevealTrackingOptions = {
  observe?: ObserveElement;
};

function defaultObserve(element: RevealTarget, onVisibilityChange: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    onVisibilityChange(true);
    return () => {};
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) onVisibilityChange(entry.isIntersecting);
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
  );
  observer.observe(element as unknown as Element);
  return () => observer.disconnect();
}

export function installRevealTracking(
  root: RevealRoot,
  { observe = defaultObserve }: RevealTrackingOptions = {},
): () => void {
  const disposers: Array<() => void> = [];
  let active = true;

  for (const element of root.querySelectorAll("[data-reveal]")) {
    if (element.classList.contains(REVEALED_CLASS)) continue;

    let unobserve: (() => void) | null = null;
    let revealed = false;
    const dispose = () => {
      if (!unobserve) return;
      const run = unobserve;
      unobserve = null;
      run();
    };
    unobserve = observe(element, (visible) => {
      if (!visible || revealed || !active) return;
      revealed = true;
      element.classList.add(REVEALED_CLASS);
      dispose();
    });
    if (revealed) {
      dispose();
    } else {
      disposers.push(dispose);
    }
  }

  return () => {
    active = false;
    for (const dispose of disposers.splice(0)) dispose();
  };
}
