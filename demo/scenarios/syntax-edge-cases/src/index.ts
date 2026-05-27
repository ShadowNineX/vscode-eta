import { Eta } from "eta";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
});

type SyntaxGallery = {
  title: string;
  users: Array<{
    first: string;
    last: string;
  }>;
  countsByStatus: Record<string, number>;
  debug: boolean;
  delimiterSamples: {
    openTag: string;
    closeTag: string;
  };
};

const gallery: SyntaxGallery = {
  title: "Syntax Gallery",
  users: [
    { first: "Ada", last: "Lovelace" },
    { first: "Alan", last: "Turing" },
  ],
  countsByStatus: {
    active: 2,
    paused: 1,
  },
  debug: true,
  delimiterSamples: {
    openTag: "<%",
    closeTag: "%>",
  },
};

console.log(eta.render("syntax-gallery", gallery));
