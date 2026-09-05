import type { Metadata } from "next";
import OperatorControlPanel from "./OperatorControlPanel";

export const metadata: Metadata = {
  title: "Operator-Steuerung · Hookemon",
  description: "Geschützte Hookemon-Steuerung für Zyklen, Packs, Karten und Entscheidungshistorie.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function OperatorPage() {
  return <OperatorControlPanel />;
}
