import { Eta } from "eta";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
});

type HelperItem = {
  label: string;
  value: number;
  status: "ok" | "warning" | "error";
};

type HelperSummary = {
  title: string;
  generatedAt: string;
  items: HelperItem[];
  featured?: HelperItem;
};

const summary: HelperSummary = {
  title: "Service Health",
  generatedAt: "2026-05-27T08:10:00.000Z",
  items: [
    { label: "API latency", value: 42, status: "ok" },
    { label: "Queue depth", value: 18, status: "warning" },
  ],
  featured: { label: "Error rate", value: 0, status: "ok" },
};

console.log(eta.render("helpers-summary", summary));
console.log(eta.render("helper-row", { item: summary.items[0] }));
console.log(eta.render("helper-badge", { status: "ok" as const, label: "Live" }));
