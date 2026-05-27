import { Eta } from "eta";
import { Eta as CoreEta } from "eta/core";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
  cache: true,
});

type FileInvoice = {
  id: string;
  customer: {
    name: string;
    email: string;
  };
  lineItems: Array<{
    description: string;
    amount: number;
  }>;
  paid: boolean;
};

type FileReceipt = {
  receiptId: string;
  total: number;
  issuedAt: string;
};

const invoice: FileInvoice = {
  id: "INV-1001",
  customer: {
    name: "Grace Hopper",
    email: "grace@example.com",
  },
  lineItems: [
    { description: "Template audit", amount: 180 },
    { description: "Integration setup", amount: 240 },
  ],
  paid: false,
};

const receipt: FileReceipt = {
  receiptId: "RCPT-1001",
  total: 420,
  issuedAt: "2026-05-27",
};

eta.loadTemplate(
  "@programmatic-snippet",
  "<aside><h2><%= it.title %></h2><p><%= it.count %></p></aside>",
);

console.log(eta.render("./file-invoice", invoice));
console.log(await eta.renderAsync("./file-receipt", receipt));
console.log(
  eta.render("@programmatic-snippet", {
    title: "Cached template",
    count: 2,
  }),
);

const browserEta = new CoreEta();
console.log(
  browserEta.renderString("Hi <%= it.name %>!", {
    name: "Browser core build",
  }),
);
