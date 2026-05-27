import { Eta } from "eta";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
});

type QuickstartProfile = {
  name: string;
  unreadCount: number;
  roles: Array<"admin" | "editor" | "viewer">;
  htmlBio: string;
  lastLogin?: string;
};

const profile: QuickstartProfile = {
  name: "Ben",
  unreadCount: 3,
  roles: ["admin", "editor"],
  htmlBio: "<strong>Eta user</strong>",
  lastLogin: "2026-05-27T08:00:00.000Z",
};

console.log(eta.render("./quickstart-profile", profile));
