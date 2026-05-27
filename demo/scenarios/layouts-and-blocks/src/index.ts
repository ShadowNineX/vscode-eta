import { Eta } from "eta";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
});

type LayoutPage = {
  title: string;
  content: string;
  navItems: Array<{
    label: string;
    href: string;
    active?: boolean;
  }>;
  metrics: {
    visits: number;
    conversionRate: number;
  };
  scripts: string[];
};

const page: LayoutPage = {
  title: "Launch Dashboard",
  content: "A short launch summary rendered through a parent layout.",
  navItems: [
    { label: "Overview", href: "/", active: true },
    { label: "Reports", href: "/reports" },
  ],
  metrics: {
    visits: 8420,
    conversionRate: 0.084,
  },
  scripts: ["/assets/page.js"],
};

console.log(eta.render("layout-page", page));
console.log(
  eta.render("layout-shell", {
    title: page.title,
    body: "<p>Layout preview body</p>",
    navItems: page.navItems,
  }),
);
