"use client";

import { useEffect } from "react";
import { installRevealTracking } from "../lib/scroll-reveal";

/** Activates the scroll reveal system for every [data-reveal] element on the page. */
export default function RevealManager() {
  useEffect(() => installRevealTracking(document), []);
  return null;
}
