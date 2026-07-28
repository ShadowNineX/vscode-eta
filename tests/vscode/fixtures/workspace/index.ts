import { Eta } from "eta";

const eta = new Eta({ views: __dirname });
const profileData = {
  user: {
    name: "Ada",
  },
  active: true,
};

eta.render("profile", profileData);
