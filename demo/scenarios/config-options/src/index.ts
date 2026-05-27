import { Eta } from "eta";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
  autoEscape: false,
  autoFilter: true,
  filterFunction: (value) =>
    typeof value === "string" ? value.trim() : String(value),
});

type ConfiguredCard = {
  title: string;
  html: string;
  tags: string[];
  owner: {
    name: string;
    email: string;
  };
  score: number;
};

const card: ConfiguredCard = {
  title: "  Runtime Options  ",
  html: "<em>Raw HTML is allowed in this scenario.</em>",
  tags: ["config", "filter", "escape"],
  owner: {
    name: "Ada",
    email: "ada@example.com",
  },
  score: 98,
};

console.log(eta.render("configured-card", card));
